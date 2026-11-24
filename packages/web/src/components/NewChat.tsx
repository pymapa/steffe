import { useState } from 'react';
import type { Project, Task } from '@steffe/shared';
import { api } from '../lib/api';
import { Composer } from './SessionView';

interface Props {
  project: Project;
  onCreated: (t: Task) => void;
}

/** An empty chat with the orchestrator. The first message starts the task; its worktree comes once work starts. */
export function NewChat({ project, onCreated }: Props) {
  const [busy, setBusy] = useState(false);

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
      <Composer
        autoFocus
        disabledReason={null}
        onSend={async (prompt, attachments) => {
          setBusy(true);
          try {
            onCreated(await api.createTask({ projectId: project.id, prompt, attachments }));
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
