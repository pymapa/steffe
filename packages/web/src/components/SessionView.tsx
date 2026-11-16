import { useState } from 'react';
import type { ImageAttachment, PermissionRequest, SessionSummary, TranscriptEntry } from '@steffe/shared';
import { api } from '../lib/api';
import { Transcript } from './Transcript';

interface Props {
  session: SessionSummary;
  transcript: TranscriptEntry[];
  permissions: PermissionRequest[];
  /** Embedded in a task view: smaller header. */
  compact?: boolean;
  /** Send somewhere else than the session itself (a task's orchestrator, which can be restarted). */
  onSend?: (text: string, images: ImageAttachment[]) => Promise<unknown>;
  /** Overrides whether the composer is enabled (default: the session is idle or running). */
  canSend?: boolean;
}

export function SessionView({ session, transcript, permissions, compact, onSend, canSend }: Props) {
  const sendable = canSend ?? (session.status === 'idle' || session.status === 'running');

  return (
    <div className={`session-view ${compact ? 'compact' : ''}`}>
      <header className="session-header">
        <div>
          {compact ? <strong>{session.role}</strong> : <h2>{session.title}</h2>}
          <div className="meta mono">
            {session.cwd}
            {session.claudeSessionId && <> · {session.claudeSessionId.slice(0, 8)}</>}
            {session.model && <> · {session.model}</>}
            {' · '}{session.permissionMode}
          </div>
        </div>
        <div className="actions">
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
        onSend={onSend ?? ((text, images) => api.sendMessage(session.id, text, images))}
        disabledReason={sendable ? null : `Session is ${session.status}`}
      />
    </div>
  );
}

/** Larger images are scaled down before sending; Claude downsizes beyond this anyway. */
const MAX_EDGE = 2000;
/** Keep each image's base64 under the API's 5 MB limit. */
const MAX_BASE64 = 5 * 1024 * 1024;
const SENDABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function toAttachment(dataUrl: string, name: string): ImageAttachment {
  const [head, data] = dataUrl.split(',', 2);
  return { mediaType: head.slice(5, head.indexOf(';')) as ImageAttachment['mediaType'], data, name };
}

/** Read a dropped/pasted image in memory, scaling it down when it's too big to send as is. */
async function loadImage(file: File): Promise<ImageAttachment> {
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

export function Composer({ onSend, disabledReason, autoFocus }: {
  onSend: (text: string, images: ImageAttachment[]) => Promise<unknown>;
  disabledReason: string | null;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const enabled = !disabledReason && !sending;

  const attach = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith('image/'));
    if (!picked.length) return false;
    setError(null);
    for (const f of picked) {
      try {
        const img = await loadImage(f);
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
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
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
            if (files.some((f) => f.type.startsWith('image/'))) {
              e.preventDefault();
              void attach(files);
            }
          }}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Ignore Enter that confirms an IME composition.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }}
          placeholder={disabledReason ?? 'Send a message… (Enter to send, Shift+Enter for a new line; drop or paste images)'}
          disabled={!!disabledReason}
          rows={3}
          autoFocus={autoFocus}
        />
      </div>
      <button className="primary" onClick={send} disabled={!enabled || (!draft.trim() && !images.length)}>Send</button>
    </footer>
  );
}
