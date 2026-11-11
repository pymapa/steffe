import { useEffect, useState } from 'react';
import type { PermissionRequest, SessionSummary, Task, TaskAgent, TranscriptEntry, WorkItem } from '@steffe/shared';
import { api } from '../lib/api';
import { STATUS_LABEL, taskStatus } from '../lib/taskStatus';
import { ImageLightbox } from './ImageLightbox';
import { Markdown } from './Markdown';
import { SessionView } from './SessionView';
import { Transcript } from './Transcript';
import { useResizable } from '../lib/useResizable';

interface Props {
  task: Task;
  sessions: SessionSummary[];
  transcripts: Record<string, TranscriptEntry[]>;
  permissions: PermissionRequest[];
  ensureTranscript: (sessionId: string) => void;
}

const COLUMNS: { title: string; statuses: WorkItem['status'][] }[] = [
  { title: 'To do', statuses: ['todo'] },
  { title: 'In progress', statuses: ['in_progress', 'needs_fix'] },
  { title: 'Validating', statuses: ['in_review', 'testing', 'awaiting_user'] },
  { title: 'Blocked', statuses: ['blocked'] },
  { title: 'Done', statuses: ['merged', 'done'] },
];

export function TaskView({ task, sessions, transcripts, permissions, ensureTranscript }: Props) {
  const leftW = useResizable({ key: 'taskLeft', initial: 45, min: 20, max: 80, unit: '%', dir: 1 });
  // The orchestrator is the user's only contact; every other agent runs autonomously.
  const defaultAgent = task.agents.some((a) => a.name === 'orchestrator') ? 'orchestrator' : (task.agents[0]?.name ?? 'orchestrator');
  const [agentName, setAgentName] = useState(defaultAgent);
  const [tab, setTab] = useState<'board' | 'report'>(task.report ? 'report' : 'board');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const questionImages = (task.question?.images ?? []).map((name) => ({
    name,
    src: `/api/tasks/${task.id}/artifacts/${encodeURIComponent(name)}`,
  }));

  useEffect(() => setAgentName(defaultAgent), [task.id, defaultAgent]);
  useEffect(() => {
    if (task.report) setTab('report');
  }, [task.report]);

  const agent = task.agents.find((a) => a.name === agentName) ?? task.agents[0];
  const session = agent ? sessions.find((s) => s.id === agent.sessionId) : undefined;
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

  const remove = () =>
    act(async () => {
      const { warnings } = await api.deleteTask(task.id, deleteBranches);
      // The view unmounts once the task is gone, so report cleanup failures outside it.
      if (warnings.length) alert(`Task deleted, but some cleanup failed:\n\n${warnings.join('\n')}`);
    }).finally(() => setDeleting(false));

  const items = task.plan?.items ?? [];
  const itemBranches = items.map((i) => i.branch).filter((b): b is string => !!b);
  const live = ['triage', 'planning', 'executing', 'escalated', 'finishing'].includes(task.phase);
  // Design-only tasks leave nothing on the task branch worth checking out.
  const canHandoff = task.phase === 'done' && !!task.worktreePath && !(items.length && items.every((i) => i.kind === 'design'));
  const agentPerms = (a: TaskAgent) => permissions.filter((p) => p.sessionId === a.sessionId).length;

  return (
    <div className="task-view">
      <header className="session-header">
        <div>
          <h2>{task.title}</h2>
          <div className="meta mono task-path" title={task.worktreePath ?? undefined}>
            {task.worktreePath
              ? `${task.branch} ← ${task.baseBranch}`
              : task.phase === 'done'
                ? `${task.branch} · handed off`
                : `${task.baseBranch} · no worktree yet`}
          </div>
        </div>
        <div className="actions">
          {(() => {
            const st = taskStatus(task, sessions, permissions);
            return (
              <span className={`pill task-status-${st.status}`} title={`phase: ${task.phase}`}>
                {STATUS_LABEL[st.status]}{st.detail ? ` · ${st.detail}` : ''}
              </span>
            );
          })()}
          <span className="pill">${task.totalCostUsd.toFixed(2)}</span>
          {task.prUrl && (
            <a className="pill link-pill" href={task.prUrl} target="_blank" rel="noreferrer">PR ↗</a>
          )}
          {canHandoff && (
            <button className="primary" disabled={busy}
              title="Remove the task worktree and check the task branch out in the project's main checkout"
              onClick={() => confirm(`Hand off? The task worktree is removed and ${task.branch} is checked out in the project.`) && act(() => api.handoffTask(task.id))}>
              Handoff
            </button>
          )}
          {task.phase === 'planning' && (
            <button className="primary" disabled={busy || !items.length} onClick={() => act(() => api.approveTask(task.id))}
              title={items.length ? 'Approve the plan (or just tell the orchestrator in the chat)' : 'The planner has not produced work items yet'}>
              Approve plan
            </button>
          )}
          {live && <button disabled={busy} onClick={() => act(() => api.pauseTask(task.id))}>Pause</button>}
          {task.phase === 'paused' && (
            <button className="primary" disabled={busy} onClick={() => act(() => api.resumeTask(task.id))}>Resume</button>
          )}
          {(live || task.phase === 'paused') && (
            <button className="danger" disabled={busy} onClick={() => confirm('Cancel this task? Agents are stopped; worktrees and branches stay.') && act(() => api.cancelTask(task.id))}>
              Cancel
            </button>
          )}
          {!live && (
            <button className="danger" disabled={busy} onClick={() => setDeleting(true)}>
              Delete
            </button>
          )}
        </div>
      </header>
      {deleting && (
        <div className="modal-backdrop" onClick={() => !busy && setDeleting(false)}>
          <div className="modal delete-task" onClick={(e) => e.stopPropagation()}>
            <h2>Delete task?</h2>
            <p className="muted">
              <strong className="delete-task-title">{task.title}</strong> and its agents, transcripts and worktrees will be removed.
            </p>
            <label className={`option-card${deleteBranches ? ' checked' : ''}`}>
              <input type="checkbox" checked={deleteBranches} disabled={busy} onChange={(e) => setDeleteBranches(e.target.checked)} />
              <div>
                <div className="option-title">Also delete branches{task.prUrl ? ' and close the PR' : ''}</div>
                <div className="option-detail">
                  {itemBranches.length ? `${itemBranches.length + 1} branches` : <span className="mono">{task.branch}</span>}, locally and on origin
                </div>
              </div>
            </label>
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setDeleting(false)}>Cancel</button>
              <button className="danger-solid" disabled={busy} onClick={remove}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <div className="error banner">{error}</div>}
      {task.lastError && <div className="error banner">{task.lastError}</div>}
      {task.question && (
        <div className="question">
          <div>
            <strong>{task.question.images?.length ? 'A design is ready for your review' : 'The orchestrator needs your input'}</strong>
            <Markdown>{task.question.text}</Markdown>
            {task.question.links && task.question.links.length > 0 && (
              <div className="question-links">
                {task.question.links.map((l) => (
                  <a key={l.url} className="button-link" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                    {l.label} ↗
                  </a>
                ))}
              </div>
            )}
            {questionImages.length > 0 && (
              <div className="question-images">
                {questionImages.map((img, i) => (
                  <button key={img.name} className="image-thumb" title={img.name} onClick={() => setLightbox(i)}>
                    <img src={img.src} alt={img.name} />
                  </button>
                ))}
              </div>
            )}
            {lightbox !== null && (
              <ImageLightbox images={questionImages} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
            )}
          </div>
          <div className="input-row">
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2}
              placeholder={task.question.images?.length ? 'Tweaks you want, or approve as is…' : 'Your answer…'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answer.trim()) {
                  void act(async () => { await api.answerTask(task.id, answer); setAnswer(''); });
                }
              }} />
            <button className="primary" disabled={busy || !answer.trim()}
              onClick={() => act(async () => { await api.answerTask(task.id, answer); setAnswer(''); })}>
              {task.question.images?.length ? 'Request tweaks' : 'Answer'}
            </button>
            {task.question.images && task.question.images.length > 0 && (
              <button className="primary" disabled={busy || !!answer.trim()} title="Approve the design as shown"
                onClick={() => act(() => api.answerTask(task.id, 'I approve this design as shown.'))}>
                Approve design
              </button>
            )}
          </div>
        </div>
      )}
      <div className="task-body" style={{ '--task-left': leftW.css } as React.CSSProperties}>
        <div className="resize-handle at-task-left" {...leftW.handleProps} />
        <section className="task-left">
          <PlanSummary task={task} />
          <nav className="tabs">
            <button className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>Board ({items.length})</button>
            {task.report && <button className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>Report</button>}
          </nav>
          <div className="tab-body">
            {tab === 'board' && (
              items.length === 0 ? (
                <div className="muted pad">
                  {task.phase === 'triage'
                    ? 'No plan yet. The orchestrator on the right is sizing up the request: it starts a planner, or goes straight to a designer or developer when that is enough.'
                    : 'No plan yet. The planner is drafting it; the orchestrator on the right relays its questions to you, and the board fills in as the plan takes shape.'}
                </div>
              ) : (
                <div className="board">
                  {COLUMNS.map((col) => {
                    const colItems = items.filter((i) => col.statuses.includes(i.status));
                    if (col.title === 'Blocked' && colItems.length === 0) return null;
                    return (
                      <div key={col.title} className="board-col">
                        <div className="board-col-title">{col.title} <span className="muted">{colItems.length}</span></div>
                        {colItems.map((i) => <ItemCard key={i.id} item={i} task={task} onAgent={setAgentName} />)}
                      </div>
                    );
                  })}
                </div>
              )
            )}
            {tab === 'report' && task.report && (
              <div className="pad">
                {task.prUrl ? (
                  <p><a href={task.prUrl} target="_blank" rel="noreferrer">{task.prUrl}</a></p>
                ) : (
                  <p className="muted">No pull request (no remote). {task.worktreePath
                    ? <>Test locally in <span className="mono">{task.worktreePath}</span>.</>
                    : <><span className="mono">{task.branch}</span> is checked out in the project.</>}</p>
                )}
                <Markdown>{task.report}</Markdown>
              </div>
            )}
          </div>
        </section>
        <section className="task-right">
          <nav className="tabs agent-tabs">
            {task.agents.map((a) => (
              <button key={a.name} className={a.name === agent?.name ? 'active' : ''} onClick={() => setAgentName(a.name)}
                title={`${a.role}${a.itemId ? ` · ${a.itemId}` : ''} · ${a.cwd}`}>
                <span className={`status ${agentDot(a, sessions)}`} />
                {a.name}
                {agentPerms(a) > 0 && <span className="badge warn">?</span>}
                {a.pendingQuestion && (
                  <span className="badge" title={`Waiting for the orchestrator: ${a.pendingQuestion}`}>Q</span>
                )}
              </button>
            ))}
          </nav>
          {agent && session ? (
            <SessionView
              key={session.id}
              session={session}
              transcript={transcripts[session.id] ?? []}
              permissions={permissions.filter((p) => p.sessionId === session.id)}
              compact
            />
          ) : (
            agent ? <StoredAgent task={task} agent={agent} /> : <div className="muted pad">No agents yet.</div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Always-visible summary of the plan: progress, the original request and the spec. */
function PlanSummary({ task }: { task: Task }) {
  const items = task.plan?.items ?? [];
  const done = items.filter((i) => i.status === 'merged' || i.status === 'done').length;
  const active = items.filter((i) => ['in_progress', 'in_review', 'testing', 'needs_fix', 'awaiting_user'].includes(i.status)).length;
  const blocked = items.filter((i) => i.status === 'blocked').length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  return (
    <div className="plan-summary">
      <div className="plan-summary-head">
        <strong>Plan</strong>
        {items.length > 0 ? (
          <span className="muted">
            {done}/{items.length} done{active ? ` · ${active} active` : ''}{blocked ? ` · ${blocked} blocked` : ''}
            {task.phase === 'planning' && ' · awaiting approval'}
          </span>
        ) : (
          <span className="muted">{task.phase === 'triage' ? 'the orchestrator is triaging…' : task.phase === 'planning' ? 'the planner is drafting…' : 'no plan'}</span>
        )}
      </div>
      {items.length > 0 && (
        <div className="progress"><div style={{ width: `${pct}%` }} className={blocked ? 'blocked' : ''} /></div>
      )}
      <div className="plan-summary-body">
        <div className="plan-request"><span className="muted">Request: </span>{task.prompt}</div>
        {task.plan?.spec && <Markdown className="plan-spec">{task.plan.spec}</Markdown>}
        {items.length > 0 && (
          <ol className="plan-items">
            {items.map((i) => (
              <li key={i.id}>
                <span className={`pill item-status-${i.status}`}>{i.status.replace('_', ' ')}</span> {i.title}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** Read-only transcript of an agent that is not running (closed, or the server restarted). */
function StoredAgent({ task, agent }: { task: Task; agent: TaskAgent }) {
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  useEffect(() => {
    setEntries(null);
    api.agentHistory(task.id, agent.name).then(setEntries).catch(() => setEntries([]));
  }, [task.id, agent.name, agent.claudeSessionId]);
  return (
    <div className="session-view compact">
      <header className="session-header">
        <div className="muted">
          <strong>{agent.name}</strong> is not running ({agent.state})
          {task.phase === 'paused' && '. Resume the task to bring it back.'}
        </div>
      </header>
      {entries === null ? (
        <div className="muted pad">Loading…</div>
      ) : (
        <Transcript
          entries={entries}
          resetKey={`${task.id}:${agent.name}`}
          chatFooter={agent.lastReport && <pre className="report-pre">{agent.lastReport}</pre>}
        />
      )}
    </div>
  );
}

function agentDot(a: TaskAgent, sessions: SessionSummary[]): string {
  const s = sessions.find((x) => x.id === a.sessionId);
  if (!s || a.state === 'closed') return 'status-ended';
  return `status-${s.status}`;
}

function ItemCard({ item, task, onAgent }: { item: WorkItem; task: Task; onAgent: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const agents = task.agents.filter((a) => a.itemId === item.id);
  return (
    <div className={`item-card item-${item.status}`} onClick={() => setOpen(!open)}>
      <div className="item-head">
        <span className="mono muted">{item.id}</span>
        <span className={`pill item-status-${item.status}`}>{item.status.replace('_', ' ')}</span>
      </div>
      <div className="item-title">{item.title}</div>
      <div className="item-meta">
        {item.kind === 'design' && <span className="pill">design</span>}
        {item.mode === 'shared' && <span className="pill">shared</span>}
        {item.validators.map((v) => <span key={v} className="pill">{v}</span>)}
        {item.attempts > 0 && <span className="pill warn-pill">fix {item.attempts}</span>}
        {item.dependsOn.length > 0 && <span className="muted">after {item.dependsOn.join(', ')}</span>}
      </div>
      {agents.length > 0 && (
        <div className="item-agents">
          {agents.map((a) => (
            <button key={a.name} className="link" onClick={(e) => { e.stopPropagation(); onAgent(a.name); }}>
              {a.name}{a.pendingQuestion ? ' (asking)' : a.busy ? ' …' : ''}
            </button>
          ))}
        </div>
      )}
      {open && (
        <div className="item-detail" onClick={(e) => e.stopPropagation()}>
          <Markdown>{item.description}</Markdown>
          <strong>Acceptance criteria</strong>
          <ul>{item.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul>
          {item.branch && <div className="mono muted">{item.branch}</div>}
          {item.notes.length > 0 && (
            <>
              <strong>Notes</strong>
              <ul className="notes">
                {item.notes.map((n, i) => (
                  <li key={i}><span className="mono muted">{n.by}</span> {n.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
