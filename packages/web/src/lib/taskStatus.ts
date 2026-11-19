import type { PermissionRequest, SessionSummary, Task } from '@steffe/shared';

/**
 * What a session (task) means for the user right now, derived from the task
 * phase and the live state of its agents:
 * - new: just created, the orchestrator is still sizing up the request
 * - working: agents are busy; nothing is needed from the user
 * - waiting: an agent needs something from the user before it can go on (a
 *   reply, a design or plan to approve, a question, a permission)
 * - handoff: the work is finished and ready for the user to pick up and test
 * - paused: stopped; resume to continue
 */
export type TaskStatus = 'new' | 'working' | 'waiting' | 'handoff' | 'paused' | 'done' | 'cancelled' | 'failed';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  new: 'New',
  working: 'Working',
  waiting: 'Waiting for you',
  handoff: 'Ready for handoff',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export interface TaskStatusInfo {
  status: TaskStatus;
  /** Short reason, e.g. "design to review". */
  detail: string;
}

const live = (s: SessionSummary | undefined) => s?.status === 'starting' || s?.status === 'running';
const sessionOf = (task: Task, sessions: SessionSummary[]) => {
  const orch = task.agents.find((a) => a.role === 'orchestrator');
  return orch ? sessions.find((s) => s.id === orch.sessionId) : undefined;
};

export function taskStatus(task: Task, sessions: SessionSummary[], permissions: PermissionRequest[]): TaskStatusInfo {
  if (task.phase === 'paused') return { status: 'paused', detail: task.lastError ? 'stopped by an error' : 'resume to continue' };
  if (task.phase === 'cancelled') return { status: 'cancelled', detail: '' };
  if (task.phase === 'failed') return { status: 'failed', detail: task.lastError ?? '' };
  if (task.phase === 'done') return { status: 'done', detail: '' };
  if (task.question) return { status: 'waiting', detail: task.question.images?.length ? 'design to review' : 'question for you' };
  if (permissions.some((p) => task.agents.some((a) => a.sessionId === p.sessionId))) {
    return { status: 'waiting', detail: 'permission needed' };
  }
  if (task.phase === 'review' && !live(sessionOf(task, sessions))) {
    return { status: 'handoff', detail: task.handedOff ? 'checked out, ready to test' : task.prUrl ? 'pull request ready to test' : 'ready to test' };
  }

  const orch = task.agents.find((a) => a.role === 'orchestrator');
  const orchSession = orch ? sessions.find((s) => s.id === orch.sessionId) : undefined;
  const working = task.agents.filter(
    (a) => a.role !== 'orchestrator' && a.state === 'active' && (a.busy || live(sessions.find((s) => s.id === a.sessionId))) && !a.pendingQuestion,
  );

  if (task.phase === 'triage' && (!orchSession || orchSession.numTurns === 0)) return { status: 'new', detail: 'sizing up the request' };
  if (live(orchSession) || working.length || task.phase === 'finishing') {
    const names = working.map((a) => a.name);
    return { status: 'working', detail: names.length ? names.join(', ') : 'orchestrator' };
  }
  // The orchestrator is idle and nobody else is working.
  if (task.phase === 'triage') return { status: 'waiting', detail: 'waiting for your reply' };
  if (task.phase === 'planning') {
    const planner = task.agents.find((a) => a.role === 'planner');
    return { status: 'waiting', detail: planner?.state === 'reported' && task.plan?.items.length ? 'plan to approve' : 'waiting for your reply' };
  }
  return { status: 'working', detail: 'orchestrator' };
}
