import { useRef, useState } from 'react';
import type { Attachment, PermissionRequest, SessionSummary, TranscriptEntry } from '@steffe/shared';
import { api } from '../lib/api';
import { useModels } from '../lib/useModels';
import { Transcript } from './Transcript';

interface Props {
  session: SessionSummary;
  transcript: TranscriptEntry[];
  permissions: PermissionRequest[];
  /** Embedded in a task view: smaller header. */
  compact?: boolean;
  /** Send somewhere else than the session itself (a task's orchestrator, which can be restarted). */
  onSend?: (text: string, attachments: Attachment[]) => Promise<unknown>;
  /** Overrides whether the composer is enabled (default: the session is idle or running). */
  canSend?: boolean;
}

export function SessionView({ session, transcript, permissions, compact, onSend, canSend }: Props) {
  const sendable = canSend ?? (session.status === 'idle' || session.status === 'running');
  // Free sessions (no role) can switch model between turns; task agents run on their role's model.
  const free = !compact && !session.role;

  return (
    <div className={`session-view ${compact ? 'compact' : ''}`}>
      <header className="session-header">
        <div>
          {compact ? <strong>{session.role}</strong> : <h2>{session.title}</h2>}
          <div className="meta mono">
            {session.cwd}
            {session.claudeSessionId && <> · {session.claudeSessionId.slice(0, 8)}</>}
            {session.model && !free && <> · {session.model}</>}
            {' · '}{session.permissionMode}
          </div>
        </div>
        <div className="actions">
          {free && (
            <ModelSelect
              value={session.model}
              disabled={!sendable}
              onChange={(model) => api.setModel(session.id, model).catch((e) => alert(String(e)))}
            />
          )}
          <span className={`pill status-${session.status}`}>{session.status}</span>
          <span className="pill">${session.totalCostUsd.toFixed(3)} · {session.numTurns} turns</span>
          {session.status === 'running' && (
            <button onClick={() => api.interrupt(session.id)}>Interrupt</button>
          )}
          {!compact && (session.status === 'idle' || session.status === 'running' || session.status === 'starting') && (
            <button className="danger" onClick={() => api.close(session.id)}>Close</button>
          )}
        </div>
      </header>
      {session.lastError && <div className="error">{session.lastError}</div>}
      <Transcript
        entries={transcript}
        resetKey={session.id}
        chatFooter={permissions.map((p) => (
          <div key={p.id} className="permission">
            <div>
              <strong>{p.toolName}</strong> wants to run:
              <pre>{JSON.stringify(p.input, null, 2)}</pre>
            </div>
            <div className="actions">
              <button className="primary" onClick={() => api.resolvePermission(p.id, true)}>Allow</button>
              <button className="danger" onClick={() => api.resolvePermission(p.id, false)}>Deny</button>
            </div>
          </div>
        ))}
      />
      <Composer
        onSend={onSend ?? ((text, attachments) => api.sendMessage(session.id, text, attachments))}
        disabledReason={sendable ? null : `Session is ${session.status}`}
      />
    </div>
  );
}

/** The model of a free session. `value` may be a full model id (reported by Claude Code) outside the list. */
export function ModelSelect({ value, onChange, disabled }: {
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
}) {
  const models = useModels();
  const extra = value && !models.includes(value) ? [value] : [];
  return (
    <select
      className="model-select"
      title="Model"
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">default model</option>
      {[...extra, ...models].map((m) => <option key={m} value={m}>{m}</option>)}
    </select>
  );
}

/** Larger images are scaled down before sending; Claude downsizes beyond this anyway. */
const MAX_EDGE = 2000;
/** Keep each image's base64 under the API's 5 MB limit. */
const MAX_BASE64 = 5 * 1024 * 1024;
const MAX_PDF_BASE64 = 20 * 1024 * 1024;
/** Text files this small are inlined into the message; they have to fit the context comfortably. */
const MAX_TEXT_BYTES = 700 * 1024;
/** Anything else is saved to disk by the server, for the session to open with its tools. */
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const SENDABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64Of(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function toAttachment(dataUrl: string, name: string): Attachment {
  const head = dataUrl.slice(0, dataUrl.indexOf(','));
  return { mediaType: head.slice(5, head.indexOf(';')) as Attachment['mediaType'], data: base64Of(dataUrl), name };
}

/** Read a dropped/pasted image in memory, scaling it down when it's too big to send as is. */
async function loadImage(file: File): Promise<Attachment> {
  const name = file.name || 'pasted image';
  const original = await readAsDataUrl(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const fits = original.length - original.indexOf(',') - 1 <= MAX_BASE64;
  if (SENDABLE.includes(file.type) && scale === 1 && fits) {
    bitmap.close();
    return toAttachment(original, name);
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let url = canvas.toDataURL('image/png');
  if (url.length > MAX_BASE64) url = canvas.toDataURL('image/jpeg', 0.85);
  if (url.length > MAX_BASE64) throw new Error(`${name} is too large to send`);
  return toAttachment(url, name);
}

/**
 * An image, a PDF or a small text file (code, CSV, logs) goes into the message itself. Any other
 * file (Office documents, archives, large text or PDFs) is sent as a file the session opens itself.
 */
async function loadFile(file: File): Promise<Attachment> {
  if (file.type.startsWith('image/')) return loadImage(file);
  const name = file.name || 'pasted file';
  if (!file.size) throw new Error(`${name} is empty`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is too large to send (max 30 MB)`);
  const data = base64Of(await readAsDataUrl(file));
  if (file.type === 'application/pdf') {
    return { mediaType: data.length <= MAX_PDF_BASE64 ? 'application/pdf' : 'application/octet-stream', data, name };
  }
  const inline = file.size <= MAX_TEXT_BYTES && !(await file.text()).includes('\0');
  return { mediaType: inline ? 'text/plain' : 'application/octet-stream', data, name };
}

export function Composer({ onSend, disabledReason, autoFocus }: {
  onSend: (text: string, attachments: Attachment[]) => Promise<unknown>;
  disabledReason: string | null;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const enabled = !disabledReason && !sending;

  const attach = async (files: File[]) => {
    if (!files.length) return false;
    setError(null);
    for (const f of files) {
      try {
        const img = await loadFile(f);
        setImages((prev) => [...prev, img]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    return true;
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !images.length) || !enabled) return;
    setError(null);
    setSending(true);
    try {
      await onSend(text, images);
      setDraft('');
      setImages([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  };

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  return (
    <footer
      className={`composer ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (!hasFiles(e) || disabledReason) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e) || disabledReason) return;
        e.preventDefault();
        setDragging(false);
        void attach([...e.dataTransfer.files]);
      }}
    >
      {error && <div className="error">{error}</div>}
      <div className="composer-input">
        {images.length > 0 && (
          <div className="composer-attachments">
            {images.map((img, i) => (
              <div key={i} className="composer-attachment" title={img.name}>
                {img.mediaType.startsWith('image/')
                  ? <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
                  : <div className="composer-file">📎 {img.name}</div>}
                <button type="button" title="Remove" onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void attach(files);
            }
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Ignore Enter that confirms an IME composition.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }}
          placeholder={disabledReason ?? 'Send a message… (Enter to send, Shift+Enter for a new line; drop or paste files)'}
          disabled={!!disabledReason}
          rows={3}
          autoFocus={autoFocus}
        />
      </div>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void attach([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <button type="button" title="Attach files" disabled={!!disabledReason} onClick={() => picker.current?.click()}>📎</button>
      <button className="primary" onClick={send} disabled={!enabled || (!draft.trim() && !images.length)}>Send</button>
    </footer>
  );
}
