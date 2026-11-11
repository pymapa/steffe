import { useState } from 'react';
import type { Project, Task } from '@steffe/shared';
import { api } from '../lib/api';

interface Props {
  project: Project;
  onCreated: (t: Task) => void;
}

/** An empty chat with the orchestrator. The first message starts the task; its worktree comes once work starts. */
export function NewChat({ project, onCreated }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createTask({ projectId: project.id, prompt }));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="session-view">
      <header className="session-header">
        <div>
          <h2>New session</h2>
          <div className="meta mono">{project.path} · orchestrator</div>
        </div>
      </header>
      <div className="transcript-scroll">
        <p className="muted">
          {busy ? 'Starting the orchestrator…' : 'Ask the orchestrator something, or tell it what you want done.'}
        </p>
      </div>
      <footer className="composer">
        {error && <div className="error">{error}</div>}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a new line. Ignore Enter that confirms an IME composition.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
          }}
          placeholder="Send a message… (Enter to send, Shift+Enter for a new line)"
          disabled={busy}
          rows={3}
          autoFocus
        />
        <button className="primary" onClick={send} disabled={busy || !draft.trim()}>Send</button>
      </footer>
    </div>
  );
}
