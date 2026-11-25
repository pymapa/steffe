import { useMemo, useState, type ReactNode } from 'react';
import type { TranscriptEntry } from '@steffe/shared';
import { useFollowTail } from '../lib/useFollowTail';
import { useResizable } from '../lib/useResizable';
import { Markdown } from './Markdown';

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
  /** notice: a one-line stand-in for a Steffe message; its full text is in the event flow. */
  role: 'user' | 'assistant' | 'notice';
  text: string;
  /**
   * An assistant message meant for the user: the text that ends a turn, or a question asked
   * with ask_user. Text followed by more tool calls is the agent thinking aloud.
   */
  toUser?: boolean;
  question?: boolean;
}

type FlowEvent =
  | { kind: 'thinking'; key: string; at: string; text: string }
  | { kind: 'system'; key: string; at: string; text: string }
  | { kind: 'steffe'; key: string; at: string; title: string; text: string }
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
  /** The latest assistant text no tool call has followed yet. */
  let closing: ChatMessage | null = null;

  for (const e of entries) {
    if (e.role === 'system') {
      const text = e.blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
      events.push({ kind: 'system', key: e.id, at: e.timestamp, text });
      continue;
    }
    const texts: string[] = [];
    let toolAfterText = false;
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
          // The turn goes on: what was said before this was not its closing message.
          if (closing) closing.toUser = false;
          closing = null;
          if (texts.length) toolAfterText = true;
          const question = b.name.endsWith('ask_user') ? (b.input as { question?: unknown } | null)?.question : null;
          if (typeof question === 'string' && question.trim()) {
            chat.push({ id: key, role: 'assistant', text: question, toUser: true, question: true });
          }
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
    if (!texts.length) continue;
    const text = texts.join('\n\n');
    if (e.role === 'user' && text.startsWith(STEFFE_PREFIX)) {
      const m = steffeMessage(text);
      chat.push(m.user !== null ? { id: e.id, role: 'user', text: m.user } : { id: e.id, role: 'notice', text: m.title });
      events.push({ kind: 'steffe', key: e.id, at: e.timestamp, title: m.title, text });
    } else if (e.role === 'assistant') {
      const message: ChatMessage = { id: e.id, role: 'assistant', text, toUser: !toolAfterText };
      // A question asked in the same entry comes after the text that preceded it.
      const at = toolAfterText ? chat.findIndex((c) => c.id.startsWith(`${e.id}:`)) : -1;
      if (at >= 0) chat.splice(at, 0, message);
      else chat.push(message);
      if (message.toUser) closing = message;
    } else {
      chat.push({ id: e.id, role: e.role, text });
    }
  }
  return { chat, events };
}

/** Steffe's own messages to an agent (new request, reports, restarts) arrive as user turns with this prefix. */
const STEFFE_PREFIX = '[steffe] ';

/**
 * How a Steffe message reads in the chat: the user's own words when it carries
 * them (the request that started the task, an answer to a question), else
 * `user` is null and the chat shows `title`, its first sentence.
 */
function steffeMessage(text: string): { user: string | null; title: string } {
  const body = text.slice(STEFFE_PREFIX.length);
  // The server wraps the request in instructions and appends the roles the orchestrator can spawn.
  const request = /^New (?:message|task) from the user/.test(body)
    ? body.match(/\n## Request\n([\s\S]*?)(?:\n\n## Roles you can spawn[\s\S]*)?$/)
    : null;
  if (request) return { user: request[1].trim(), title: 'New request from the user' };
  const answer = body.match(/^The user answered your question\.[\s\S]*?\n\nAnswer: ([\s\S]*)$/);
  if (answer) return { user: answer[1].trim(), title: 'The user answered your question' };
  const first = (body.split('\n')[0] ?? '').replace(/\*\*/g, '');
  return { user: null, title: first.split(/(?<=\.)\s/)[0] };
}

// --- chat --------------------------------------------------------------------

function Chat({ entries }: { entries: ChatMessage[] }) {
  if (entries.length === 0) return <div className="muted">No messages yet.</div>;
  return (
    <div className="transcript">
      {entries.map((e) => (
        <div key={e.id} className={`entry entry-${e.role} ${e.toUser ? 'to-user' : e.role === 'assistant' ? 'aside' : ''}`}>
          <div className="entry-role">{e.role === 'notice' ? 'steffe' : e.question ? 'question' : e.toUser ? 'to you' : e.role}</div>
          <div className="entry-body">
            {e.role === 'assistant' ? (
              <Markdown>{e.text}</Markdown>
            ) : (
              <div className={e.role === 'notice' ? 'muted' : 'block-text'}>{e.text}</div>
            )}
          </div>
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
    case 'steffe':
      return <details className="block-result"><summary>steffe · {ev.title}</summary><pre>{ev.text}</pre></details>;
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
