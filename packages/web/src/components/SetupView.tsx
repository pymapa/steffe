import { useEffect, useState } from 'react';
import type {
  CatalogEntry,
  PermissionRequest,
  Project,
  ProjectCatalog,
  ProjectSetup,
  RoleWiring,
  SessionSummary,
  TranscriptEntry,
} from '@steffe/shared';
import { api } from '../lib/api';
import { Markdown } from './Markdown';
import { SessionView } from './SessionView';
import { useResizable } from '../lib/useResizable';

interface Props {
  project: Project;
  catalog: ProjectCatalog | null;
  /** The project's live setup agent, if one is running. */
  session: SessionSummary | null;
  transcripts: Record<string, TranscriptEntry[]>;
  permissions: PermissionRequest[];
  ensureTranscript: (sessionId: string) => void;
  onOpenEntry: (kind: CatalogEntry['kind'], name: string) => void;
}

/** The project's live setup agent (a task-less session in the setup role). */
export function setupSession(projectId: string, sessions: SessionSummary[]): SessionSummary | null {
  return sessions.find((s) => s.projectId === projectId && s.role === 'setup' && !s.taskId) ?? null;
}

/**
 * How Steffe's roles use the project's own agents and skills: the setup
 * agent's proposal (accept or discuss it in the chat) and the accepted setup.
 */
export function SetupView({ project, catalog, session, transcripts, permissions, ensureTranscript, onOpenEntry }: Props) {
  const leftW = useResizable({ key: 'setupLeft', initial: 55, min: 25, max: 80, unit: '%', dir: 1 });
  const proposal = project.setupProposal ?? null;
  const accepted = project.setup ?? null;
  const [showing, setShowing] = useState<'proposal' | 'accepted'>(proposal ? 'proposal' : 'accepted');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setShowing(proposal ? 'proposal' : 'accepted'), [proposal?.updatedAt]);
  useEffect(() => {
    if (session) ensureTranscript(session.id);
  }, [session?.id, ensureTranscript]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const running = session && (session.status === 'starting' || session.status === 'running');
  const shown = showing === 'proposal' ? proposal : accepted;
  const projectAgents = catalog?.agents.filter((e) => e.source === 'project').length ?? 0;
  const projectSkills = catalog?.skills.filter((e) => e.source === 'project').length ?? 0;

  let status: string;
  if (proposal) status = 'proposal ready';
  else if (running) status = 'analyzing…';
  else if (accepted) status = `in use · ${accepted.roles.length} roles`;
  else status = 'not set up';

  const left = (
    <section className="task-left">
      {proposal && accepted && (
        <nav className="tabs">
          <button className={showing === 'proposal' ? 'active' : ''} onClick={() => setShowing('proposal')}>Proposal</button>
          <button className={showing === 'accepted' ? 'active' : ''} onClick={() => setShowing('accepted')}>In use</button>
        </nav>
      )}
      <div className="tab-body">
        {shown ? (
          <SetupDetail
            setup={shown}
            compareTo={showing === 'proposal' ? accepted : null}
            catalog={catalog}
            onOpenEntry={onOpenEntry}
          />
        ) : (
          <div className="muted pad">
            {running
              ? 'The setup agent is reading the project’s agents, skills and tooling. Its proposal shows up here; you can follow along and steer it in the chat.'
              : `No setup yet. The project has ${projectAgents} subagent${projectAgents === 1 ? '' : 's'} and ${projectSkills} skill${projectSkills === 1 ? '' : 's'}. Task agents already load them all, but no role is told which ones matter for its job. Analyze the project to get a proposal.`}
          </div>
        )}
      </div>
    </section>
  );

  return (
    <div className="task-view">
      <header className="session-header">
        <div>
          <h2>Project setup</h2>
          <div className="meta">How Steffe’s roles use {project.name}’s own agents and skills in tasks.</div>
        </div>
        <div className="actions">
          <span className={`pill ${proposal ? 'task-status-handoff' : running ? 'task-status-working' : ''}`}>{status}</span>
          {session && <span className="pill">${session.totalCostUsd.toFixed(2)}</span>}
          {proposal && (
            <>
              <button className="primary" disabled={busy} onClick={() => act(() => api.acceptSetup(project.id))}
                title="Use this setup for agents started from now on">
                Accept
              </button>
              <button disabled={busy} onClick={() => act(() => api.dismissSetup(project.id))}>Dismiss</button>
            </>
          )}
          {!proposal && (
            <button className={accepted ? '' : 'primary'} disabled={busy || !!running}
              onClick={() => act(() => api.analyzeSetup(project.id))}>
              {accepted || session ? 'Re-analyze' : 'Analyze project'}
            </button>
          )}
          {accepted && !proposal && (
            <button className="danger" disabled={busy}
              onClick={() => confirm('Stop applying this setup to new task agents?') && act(() => api.clearSetup(project.id))}>
              Remove
            </button>
          )}
        </div>
      </header>
      {error && <div className="error banner">{error}</div>}
      {session ? (
        <div className="task-body" style={{ '--task-left': leftW.css } as React.CSSProperties}>
          <div className="resize-handle at-task-left" {...leftW.handleProps} />
          {left}
          <section className="task-right">
            <SessionView
              key={session.id}
              session={session}
              transcript={transcripts[session.id] ?? []}
              permissions={permissions.filter((p) => p.sessionId === session.id)}
              compact
            />
          </section>
        </div>
      ) : (
        <div className="task-body single">{left}</div>
      )}
    </div>
  );
}

function SetupDetail({
  setup,
  compareTo,
  catalog,
  onOpenEntry,
}: {
  setup: ProjectSetup;
  compareTo: ProjectSetup | null;
  catalog: ProjectCatalog | null;
  onOpenEntry: Props['onOpenEntry'];
}) {
  const change = (w: RoleWiring): string | null => {
    if (!compareTo) return null;
    const old = compareTo.roles.find((r) => r.role === w.role);
    if (!old) return 'new';
    return JSON.stringify(old) === JSON.stringify(w) ? null : 'changed';
  };
  const dropped = compareTo?.roles.filter((r) => !setup.roles.some((w) => w.role === r.role)) ?? [];
  const exists = (kind: CatalogEntry['kind'], name: string) =>
    !catalog || (kind === 'agent' ? catalog.agents : catalog.skills).some((e) => e.source === 'project' && e.name === name);
  const chip = (kind: CatalogEntry['kind'], name: string) => (
    <button key={`${kind}:${name}`} className={`setup-chip chip-${kind}`} disabled={!exists(kind, name)}
      title={exists(kind, name) ? `Open the ${kind}` : `No project ${kind} named ${name} any more`}
      onClick={() => onOpenEntry(kind, name)}>
      <span className="muted">{kind}</span> {name}
    </button>
  );

  return (
    <div className="pad setup-detail">
      <Markdown>{setup.summary}</Markdown>
      <h3>Roles</h3>
      {setup.roles.length === 0 && <p className="muted">No role needs anything beyond CLAUDE.md.</p>}
      {setup.roles.map((w) => (
        <div key={w.role} className="setup-role">
          <div className="setup-role-head">
            <strong>{w.role}</strong>
            {change(w) && <span className={`pill setup-${change(w)}`}>{change(w)}</span>}
            <span className="setup-chips">
              {w.skills.map((s) => chip('skill', s))}
              {w.agents.map((a) => chip('agent', a))}
            </span>
          </div>
          <Markdown>{w.guidance}</Markdown>
        </div>
      ))}
      {dropped.length > 0 && (
        <p className="muted">No longer wired: {dropped.map((r) => r.role).join(', ')}.</p>
      )}
      {setup.suggestions.length > 0 && (
        <>
          <h3>Suggestions</h3>
          <ul className="setup-suggestions">
            {setup.suggestions.map((s, i) => (
              <li key={i}><Markdown>{s}</Markdown></li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small-text">Updated {new Date(setup.updatedAt).toLocaleString()}</p>
    </div>
  );
}
