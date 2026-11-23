import { useEffect, useRef, useState } from 'react';
import type { ImageAttachment, PermissionRequest, SessionSummary, Task, TaskAgent, TranscriptEntry, WorkItem } from '@steffe/shared';
import { api } from '../lib/api';
import { STATUS_LABEL, taskStatus } from '../lib/taskStatus';
import { ImageLightbox } from './ImageLightbox';
import { Markdown } from './Markdown';
import { RetroView } from './RetroView';
import { Composer, SessionView } from './SessionView';
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
  const [tab, setTab] = useState<'board' | 'report' | 'retro'>(task.report ? 'report' : 'board');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Screenshots the user picked, e.g. one of several alternatives; named in the answer.
  const [chosen, setChosen] = useState<string[]>([]);
  const questionImages = (task.question?.images ?? []).map((name) => ({
    name,
    src: `/api/tasks/${task.id}/artifacts/${encodeURIComponent(name)}`,
  }));

  useEffect(() => setAgentName(defaultAgent), [task.id, defaultAgent]);
  useEffect(() => setChosen([]), [task.question?.id]);
  const toggleChosen = (name: string) =>
    setChosen((c) => (c.includes(name) ? c.filter((n) => n !== name) : [...c, name]));
  const chosenList = chosen.map((n) => `\`${n}\``).join(', ');
  const sendAnswer = () =>
    act(async () => {
      await api.answerTask(task.id, chosen.length ? `I choose the design shown in ${chosenList}.

${answer}` : answer);
      setAnswer('');
    });
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
      const { warnings } = await api.deleteTask(task.id, deleteBranches || task.phase === 'done');
      // The view unmounts once the task is gone, so report cleanup failures outside it.
      if (warnings.length) alert(`Task deleted, but some cleanup failed:\n\n${warnings.join('\n')}`);
    }).finally(() => setDeleting(false));

  const items = task.plan?.items ?? [];
  const itemBranches = items.map((i) => i.branch).filter((b): b is string => !!b);
  const live = ['triage', 'planning', 'executing', 'escalated', 'finishing'].includes(task.phase);
  // The orchestrator stays reachable after the task ends: messaging it resumes it.
  const orchSend = (text: string, images: ImageAttachment[]) => api.messageTask(task.id, text, images);
  const orchDisabled = task.phase === 'paused' ? 'The task is paused: resume it to continue' : null;
  // A retro looks back at a round that has ended.
  const canRetro = ['review', 'done', 'cancelled', 'failed'].includes(task.phase) && task.agents.length > 1;
  // A task that took over a pull request (checkout_pr) has a branch but no worktree.
  const canHandoff = !live && task.phase !== 'paused' && (!!task.worktreePath || (task.adoptedPr != null && !task.handedOff));
  const handoff = () =>
    confirm(
      `Hand off "${task.title}"?\n\nThe task's worktrees are removed (agents' running apps are stopped) and ${task.branch} is checked out in your main checkout. Both must have no uncommitted changes.`,
    ) && act(() => api.handoffTask(task.id));
  const agentPerms = (a: TaskAgent) => permissions.filter((p) => p.sessionId === a.sessionId).length;

  const agentBadges = (a: TaskAgent) => (
    <>
      {agentPerms(a) > 0 && <span className="badge warn">?</span>}
      {a.pendingQuestion && (
        <span className="badge" title={`Waiting for the orchestrator: ${a.pendingQuestion}`}>Q</span>
      )}
      {a.state === 'queued' && (
        <span className="badge" title="Queued: starts when an agent slot frees up">…</span>
      )}
    </>
  );
  const agentTitle = (a: TaskAgent) =>
    `${a.role}${a.itemId ? ` · ${a.itemId}` : ''} · ${formatMinutes(a.activeMs)} active · $${a.costUsd.toFixed(2)} · ${a.cwd}`;

  return (
    <div className="task-view">
      <header className="session-header">
        <div>
          <h2>{task.title}</h2>
          <div className="meta mono task-path" title={task.worktreePath ?? undefined}>
            {task.handedOff
              ? `${task.handedOff} · checked out in your main checkout`
              : task.worktreePath || task.adoptedPr != null
                ? `${task.branch} ← ${task.baseBranch}`
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
          {task.phase === 'review' && (
            <button disabled={busy} onClick={() => act(() => api.completeTask(task.id))}
              title="Tested, merged or otherwise closed: mark the task done. You can still chat with the orchestrator.">
              Mark done
            </button>
          )}
          {(live || task.phase === 'paused' || task.phase === 'review') && (
            <button className="danger" disabled={busy} onClick={() => confirm('Cancel this task? Agents are stopped; worktrees and branches stay.') && act(() => api.cancelTask(task.id))}>
              Cancel
            </button>
          )}
          {canHandoff && (
            <button className="primary" disabled={busy} onClick={handoff}
              title="Remove the task worktree and check the branch out in your main checkout for local testing">
              Handoff
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
            <label className={`option-card${deleteBranches || task.phase === 'done' ? ' checked' : ''}`}>
              <input
                type="checkbox"
                checked={deleteBranches || task.phase === 'done'}
                disabled={busy || task.phase === 'done'}
                onChange={(e) => setDeleteBranches(e.target.checked)}
              />
              <div>
                <div className="option-title">Also delete branches{task.prUrl ? ' and close the PR' : ''}</div>
                <div className="option-detail">
                  {itemBranches.length ? `${itemBranches.length + 1} branches` : <span className="mono">{task.branch}</span>}, locally and on origin.
                  Your main checkout goes back to <span className="mono">{task.baseBranch}</span>, updated from origin.
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
                  <figure key={img.name} className={chosen.includes(img.name) ? 'chosen' : undefined}>
                    <button className="image-thumb" title={img.name} onClick={() => setLightbox(i)}>
                      <img src={img.src} alt={img.name} />
                    </button>
                    <figcaption>
                      <span className="muted" title={img.name}>{img.name}</span>
                      <button className={`small${chosen.includes(img.name) ? ' primary' : ''}`} title="Choose this design"
                        onClick={() => toggleChosen(img.name)}>
                        {chosen.includes(img.name) ? '✓ Chosen' : 'Choose'}
                      </button>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
            {lightbox !== null && (
              <ImageLightbox images={questionImages} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)}
                chosen={chosen} onToggleChosen={toggleChosen} />
            )}
          </div>
          <div className="input-row">
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2}
              placeholder={task.question.images?.length ? 'Tweaks you want, or approve as is…' : 'Your answer…'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && answer.trim()) {
                  void sendAnswer();
                }
              }} />
            <button className="primary" disabled={busy || !answer.trim()}
              onClick={() => void sendAnswer()}>
              {task.question.images?.length ? 'Request tweaks' : 'Answer'}
            </button>
            {task.question.images && task.question.images.length > 0 && (
              <button className="primary" disabled={busy || !!answer.trim()}
                title={chosen.length ? `Approve ${chosen.join(', ')} as shown` : 'Approve the design as shown'}
                onClick={() => act(() => api.answerTask(task.id, chosen.length
                  ? `I approve the design shown in ${chosenList}, as shown.`
                  : 'I approve this design as shown.'))}>
                {chosen.length ? 'Approve chosen' : 'Approve design'}
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
            {(task.retro || canRetro) && (
              <button className={tab === 'retro' ? 'active' : ''} onClick={() => setTab('retro')}>
                Retro{task.retro?.state === 'running' ? ' …' : ''}
              </button>
            )}
          </nav>
          <div className="tab-body">
            {tab === 'board' && (
              items.length === 0 ? (
                <div className="muted pad">
                  {task.phase === 'triage'
                    ? 'No plan yet. The orchestrator on the right is sizing up the request: it plans the work and starts a developer (or a planner or designer, if you ask for one).'
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
            {tab === 'retro' && <RetroView task={task} canRun={canRetro} />}
            {tab === 'report' && task.report && (
              <div className="pad">
                {task.prUrl ? (
                  <p><a href={task.prUrl} target="_blank" rel="noreferrer">{task.prUrl}</a></p>
                ) : task.handedOff ? (
                  <p className="muted">No pull request (no remote). <span className="mono">{task.handedOff}</span> is checked out in your main checkout.</p>
                ) : (
                  <p className="muted">No pull request (no remote). Test locally in <span className="mono">{task.worktreePath}</span>, or hand it off to check it out in your main checkout.</p>
                )}
                <Markdown>{task.report}</Markdown>
              </div>
            )}
          </div>
        </section>
        <section className="task-right">
          <nav className="tabs agent-tabs">
            {agentGroups(task.agents).map(({ role, agents }) =>
              agents.length === 1 ? (
                <button key={role} className={agents[0].name === agent?.name ? 'active' : ''}
                  onClick={() => setAgentName(agents[0].name)} title={agentTitle(agents[0])}>
                  <span className={`status ${agentDot(agents[0], sessions)}`} />
                  {agents[0].name}
                  {agentBadges(agents[0])}
                </button>
              ) : (
                <AgentGroupMenu key={role} role={role} agents={agents} sessions={sessions} active={agent?.name}
                  onSelect={setAgentName} perms={agents.reduce((n, a) => n + agentPerms(a), 0)}
                  badges={agentBadges} title={agentTitle} />
              ),
            )}
          </nav>
          {agent && session ? (
            <SessionView
              key={session.id}
              session={session}
              transcript={transcripts[session.id] ?? []}
              permissions={permissions.filter((p) => p.sessionId === session.id)}
              compact
              {...(agent.role === 'orchestrator' ? { onSend: orchSend, canSend: !orchDisabled } : {})}
            />
          ) : (
            agent ? (
              <StoredAgent task={task} agent={agent}
                composer={agent.role === 'orchestrator' && <Composer onSend={orchSend} disabledReason={orchDisabled} />} />
            ) : <div className="muted pad">No agents yet.</div>
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
function StoredAgent({ task, agent, composer }: { task: Task; agent: TaskAgent; composer?: React.ReactNode }) {
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
          {agent.state === 'queued'
            ? ': it starts by itself when an agent slot frees up.'
            : task.phase === 'paused'
            ? '. Resume the task to bring it back.'
            : composer
              ? '. Send a message to bring it back.'
              : ''}
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
      {composer}
    </div>
  );
}

/** A role with several agents: one tab that opens a dropdown listing them. */
function AgentGroupMenu({ role, agents, sessions, active, onSelect, perms, badges, title }: {
  role: string;
  agents: TaskAgent[];
  sessions: SessionSummary[];
  active?: string;
  onSelect: (name: string) => void;
  perms: number;
  badges: (a: TaskAgent) => React.ReactNode;
  title: (a: TaskAgent) => string;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = agents.find((a) => a.name === active);
  const questions = agents.filter((a) => a.pendingQuestion).length;

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onScroll = (e: Event) => !menuRef.current?.contains(e.target as Node) && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [pos]);

  const toggle = () => {
    if (pos) return setPos(null);
    // Fixed position: the tab strip scrolls horizontally and would clip an absolute menu.
    const r = buttonRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 2, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) });
  };

  return (
    <>
      <button ref={buttonRef} className={`agent-group-toggle${current ? ' active' : ''}`} onClick={toggle}
        title={agents.map((a) => a.name).join(', ')}>
        <span className={`status ${current ? agentDot(current, sessions) : groupDot(agents, sessions)}`} />
        {current ? current.name : `${roleLabel(role)} (${agents.length})`}
        {perms > 0 && <span className="badge warn">?</span>}
        {questions > 0 && <span className="badge" title={`${questions} waiting for the orchestrator`}>Q</span>}
        <span className="chevron">▾</span>
      </button>
      {pos && (
        <div ref={menuRef} className="agent-menu" style={{ top: pos.top, left: pos.left }}>
          <div className="agent-menu-title">{roleLabel(role)} ({agents.length})</div>
          {agents.map((a) => (
            <button key={a.name} className={a.name === active ? 'active' : ''} title={title(a)}
              onClick={() => { onSelect(a.name); setPos(null); }}>
              <span className={`status ${agentDot(a, sessions)}`} />
              <span className="agent-menu-name">{a.name}</span>
              {a.itemId && <span className="muted mono">{a.itemId}</span>}
              {badges(a)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Agents grouped by role, groups in order of first appearance. */
function agentGroups(agents: TaskAgent[]): { role: string; agents: TaskAgent[] }[] {
  const groups = new Map<string, TaskAgent[]>();
  for (const a of agents) groups.set(a.role, [...(groups.get(a.role) ?? []), a]);
  return [...groups].map(([role, agents]) => ({ role, agents }));
}

function roleLabel(role: string): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}s`;
}

const DOT_PRIORITY = ['status-error', 'status-running', 'status-starting', 'status-idle', 'status-ended'];

/** The most noteworthy state among a group's agents. */
function groupDot(agents: TaskAgent[], sessions: SessionSummary[]): string {
  const dots = agents.map((a) => agentDot(a, sessions));
  return DOT_PRIORITY.find((d) => dots.includes(d)) ?? 'status-ended';
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

/** Agent working time, e.g. "12 min" or "1 h 05 min". */
function formatMinutes(ms: number): string {
  const min = Math.round((ms ?? 0) / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
