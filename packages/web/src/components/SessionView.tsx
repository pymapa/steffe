import { useState } from 'react';
import type { PermissionRequest, SessionSummary, TranscriptEntry } from '@steffe/shared';
import { api } from '../lib/api';
import { Transcript } from './Transcript';

interface Props {
  session: SessionSummary;
  transcript: TranscriptEntry[];
  permissions: PermissionRequest[];
  /** Embedded in a task view: smaller header. */
  compact?: boolean;
}

export function SessionView({ session, transcript, permissions, compact }: Props) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canSend = session.status === 'idle' || session.status === 'running';

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    try {
      await api.sendMessage(session.id, text);
      setDraft('');
    } catch (e) {
      setError(String(e));
    }
  };

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
      <footer className="composer">
        {error && <div className="error">{error}</div>}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Ignore Enter that confirms an IME composition.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }}
          placeholder={canSend ? 'Send a message… (Enter to send, Shift+Enter for a new line)' : `Session is ${session.status}`}
          disabled={!canSend}
          rows={3}
        />
        <button className="primary" onClick={send} disabled={!canSend || !draft.trim()}>Send</button>
      </footer>
    </div>
  );
}
