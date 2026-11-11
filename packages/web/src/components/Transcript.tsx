import { useMemo, useState, type ReactNode } from 'react';
import type { TranscriptEntry } from '@steffe/shared';
import { useFollowTail } from '../lib/useFollowTail';
import { useResizable } from '../lib/useResizable';

/**
 * A session split in two: the conversation (user and assistant text) and the
 * event flow (thinking, tool calls with their results, system notices). Each
 * pane scrolls and follows its own tail.
 */
export function Transcript({
  entries,
  resetKey,
  chatFooter,
}: {
  entries: TranscriptEntry[];
  /** Changes when another session is shown; both panes jump to the bottom. */
  resetKey: unknown;
  /** Rendered under the chat (permission prompts, a final report). */
  chatFooter?: ReactNode;
}) {
  const { chat, events } = useMemo(() => split(entries), [entries]);
  const [showEvents, setShowEvents] = useState(() => readPref());
  const eventsW = useResizable({ key: 'events', initial: 40, min: 15, max: 75, unit: '%', dir: -1 });
  const toggle = () => {
    setShowEvents((v) => {
      writePref(!v);
      return !v;
    });
  };

  return (
    <div className={`split ${showEvents ? '' : 'events-hidden'}`} style={{ '--events-w': eventsW.css } as React.CSSProperties}>
      {showEvents && <div className="resize-handle at-events" {...eventsW.handleProps} />}
      <Pane resetKey={resetKey} className="chat-pane">
        {entries.length === 0 ? <div className="muted">Waiting for output…</div> : <Chat entries={chat} />}
        {chatFooter}
      </Pane>
      {showEvents ? (
        <Pane
          resetKey={resetKey}
          className="events-pane"
          header={
            <div className="pane-header">
              <span>Events · {events.length}</span>
              <button className="link" onClick={toggle} title="Hide event flow">hide</button>
            </div>
          }
        >
          {events.length === 0 ? <div className="muted">No events yet.</div> : <Events events={events} />}
        </Pane>
      ) : (
        <button className="events-show" onClick={toggle} title="Show event flow">
          Events · {events.length}
        </button>
      )}
    </div>
  );
}

function Pane({ resetKey, className, header, children }: {
  resetKey: unknown;
  className: string;
  header?: ReactNode;
  children: ReactNode;
}) {
  const tail = useFollowTail<HTMLDivElement>(resetKey);
  return (
    <div className={`pane ${className}`}>
      {header}
      <div className="transcript-wrap">
        <div className="transcript-scroll" ref={tail.ref}>{children}</div>
        {!tail.following && <button className="jump-latest" onClick={tail.jump}>↓ Latest</button>}
      </div>
    </div>
  );
}

// --- splitting ---------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

type FlowEvent =
  | { kind: 'thinking'; key: string; at: string; text: string }
  | { kind: 'system'; key: string; at: string; text: string }
  | { kind: 'tool'; key: string; at: string; name: string; input: unknown; result: ToolResult | null }
  | { kind: 'orphan_result'; key: string; at: string; result: ToolResult };

interface ToolResult {
  content: string;
  isError: boolean;
}

function split(entries: TranscriptEntry[]): { chat: ChatMessage[]; events: FlowEvent[] } {
  const chat: ChatMessage[] = [];
  const events: FlowEvent[] = [];
  const tools = new Map<string, Extract<FlowEvent, { kind: 'tool' }>>();

  for (const e of entries) {
    if (e.role === 'system') {
      const text = e.blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
      events.push({ kind: 'system', key: e.id, at: e.timestamp, text });
      continue;
    }
    const texts: string[] = [];
    e.blocks.forEach((b, i) => {
      const key = `${e.id}:${i}`;
      switch (b.type) {
        case 'text':
          if (b.text.trim()) texts.push(b.text);
          break;
        case 'thinking':
          events.push({ kind: 'thinking', key, at: e.timestamp, text: b.text });
          break;
        case 'tool_use': {
          const ev = { kind: 'tool' as const, key, at: e.timestamp, name: b.name, input: b.input, result: null };
          tools.set(b.id, ev);
          events.push(ev);
          break;
        }
        case 'tool_result': {
          const result = { content: b.content, isError: b.isError };
          const use = tools.get(b.toolUseId);
          if (use) use.result = result;
          else events.push({ kind: 'orphan_result', key, at: e.timestamp, result });
          break;
        }
      }
    });
    if (texts.length) chat.push({ id: e.id, role: e.role, text: texts.join('\n\n') });
  }
  return { chat, events };
}

// --- chat --------------------------------------------------------------------

function Chat({ entries }: { entries: ChatMessage[] }) {
  if (entries.length === 0) return <div className="muted">No messages yet.</div>;
  return (
    <div className="transcript">
      {entries.map((e) => (
        <div key={e.id} className={`entry entry-${e.role}`}>
          <div className="entry-role">{e.role}</div>
          <div className="entry-body"><div className="block-text">{e.text}</div></div>
        </div>
      ))}
    </div>
  );
}

// --- event flow --------------------------------------------------------------

function Events({ events }: { events: FlowEvent[] }) {
  return (
    <ol className="events">
      {events.map((ev) => (
        <li key={ev.key} className={`event event-${ev.kind}`}>
          <span className="event-time mono">{time(ev.at)}</span>
          <div className="event-body"><EventBody ev={ev} /></div>
        </li>
      ))}
    </ol>
  );
}

function EventBody({ ev }: { ev: FlowEvent }) {
  switch (ev.kind) {
    case 'thinking':
      return <details className="block-thinking"><summary>thinking · {firstLine(ev.text)}</summary><pre>{ev.text}</pre></details>;
    case 'system':
      return <div className="event-system">{ev.text}</div>;
    case 'orphan_result':
      return <Result result={ev.result} />;
    case 'tool':
      return <ToolCall ev={ev} />;
  }
}

function ToolCall({ ev }: { ev: Extract<FlowEvent, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const state = ev.result === null ? 'pending' : ev.result.isError ? 'error' : 'ok';
  return (
    <div className={`block-tool tool-${state}`}>
      <button className="link" onClick={() => setOpen(!open)}>
        <span className="tool-state" aria-label={state} />
        <span className="tool-name">{ev.name}</span>
        <span className="muted"> {summarize(ev.input)}</span>
      </button>
      {open && (
        <>
          <pre>{JSON.stringify(ev.input, null, 2)}</pre>
          {ev.result ? <Result result={ev.result} /> : <div className="muted small-text">running…</div>}
        </>
      )}
    </div>
  );
}

function Result({ result }: { result: ToolResult }) {
  return (
    <details className={`block-result ${result.isError ? 'is-error' : ''}`}>
      <summary>{result.isError ? 'error' : 'result'} · {firstLine(result.content)}</summary>
      <pre>{result.content}</pre>
    </details>
  );
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.pattern ?? i.description ?? i.prompt ?? i.url;
  return typeof pick === 'string' ? pick.slice(0, 120) : '';
}

function firstLine(s: string) {
  const line = s.split('\n')[0] ?? '';
  return line.length > 100 ? line.slice(0, 100) + '…' : line;
}

function time(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const PREF_KEY = 'steffe.showEvents';
function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== '0';
  } catch {
    return true;
  }
}
function writePref(v: boolean) {
  try {
    localStorage.setItem(PREF_KEY, v ? '1' : '0');
  } catch {
    // ignore
  }
}
