import { useEffect, useState } from 'react';
import type { PermissionMode, Project, SessionSummary, StoredSession } from '@steffe/shared';
import { api } from '../lib/api';
import { Composer, ModelSelect } from './SessionView';

interface Props {
  project: Project;
  onCreated: (s: SessionSummary) => void;
}

const MODEL_KEY = 'steffe.freeSessionModel';
const MODE_KEY = 'steffe.freeSessionMode';

const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits, ask before commands' },
  { value: 'plan', label: 'Plan only' },
  { value: 'bypassPermissions', label: 'Never ask (bypass permissions)' },
];

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // not remembered
  }
}

/** An empty free session: plain Claude Code in the project's folder, no orchestrator. The first message starts it. */
export function NewSession({ project, onCreated }: Props) {
  const [model, setModel] = useState<string | null>(() => remembered(MODEL_KEY));
  const [mode, setMode] = useState<PermissionMode>(
    () => MODES.find((m) => m.value === remembered(MODE_KEY))?.value ?? 'default',
  );
  const [stored, setStored] = useState<StoredSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listStoredSessions(project.id).then(setStored).catch(() => setStored([]));
  }, [project.id]);

  const resume = async (s: StoredSession) => {
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await api.createSession({
          projectId: project.id,
          prompt: '',
          resumeSessionId: s.claudeSessionId,
          title: s.firstPrompt.slice(0, 60) || undefined,
          model: model ?? undefined,
          permissionMode: mode,
        }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="session-view">
      <header className="session-header">
        <div>
          <h2>New free session</h2>
          <div className="meta mono">{project.path} · Claude Code, no orchestrator</div>
        </div>
      </header>
      <div className="transcript-scroll">
        <div className="new-session-options">
          <label>
            Model
            <ModelSelect value={model} onChange={(m) => { setModel(m); remember(MODEL_KEY, m); }} />
          </label>
          <label>
            Permissions
            <select value={mode} onChange={(e) => { setMode(e.target.value as PermissionMode); remember(MODE_KEY, e.target.value); }}>
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
        </div>
        {error && <div className="error">{error}</div>}
        <p className="muted">
          {busy ? 'Starting…' : 'Send a message to start. The model can be changed later, between turns.'}
        </p>
        {stored && stored.length > 0 && (
          <>
            <h3 className="new-session-resume-head">Resume an earlier session in this folder</h3>
            <ul className="session-list new-session-resume">
              {stored.slice(0, 20).map((s) => (
                <li key={s.claudeSessionId} className="session-item" onClick={() => { if (!busy) void resume(s); }}>
                  <div className="row"><span className="title">{s.firstPrompt || s.claudeSessionId.slice(0, 8)}</span></div>
                  <div className="meta"><span>{new Date(s.updatedAt).toLocaleString()}</span></div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <Composer
        autoFocus
        disabledReason={null}
        onSend={async (prompt, attachments) => {
          setBusy(true);
          try {
            onCreated(
              await api.createSession({
                projectId: project.id,
                prompt,
                attachments,
                model: model ?? undefined,
                permissionMode: mode,
              }),
            );
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
