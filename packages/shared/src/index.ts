/**
 * Types shared between the Steffe server and web UI.
 * The wire protocol is: REST for commands, WebSocket for live events.
 */

export type SessionStatus =
  | 'starting' // query() spawned, waiting for the init message
  | 'running' // Claude is working on a turn
  | 'idle' // waiting for the next user message
  | 'ended' // query completed / closed cleanly
  | 'error'; // query threw

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** An opened repository / folder. Sessions are always created inside a project. */
export interface Project {
  id: string;
  name: string;
  /** Absolute path; used as the cwd of every session in the project. */
  path: string;
  createdAt: string;
  lastOpenedAt: string;
}

/** Request body for POST /api/projects */
export interface CreateProjectRequest {
  path: string;
  name?: string;
}

export interface SessionSummary {
  /** Steffe-side id (stable from creation, before the SDK session id is known). */
  id: string;
  projectId: string;
  /** Claude Code session id, once the init message has arrived. Used for resume. */
  claudeSessionId: string | null;
  title: string;
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  totalCostUsd: number;
  numTurns: number;
  lastError: string | null;
  /** Set when this session is an agent inside a Task. */
  taskId: string | null;
  /** Role name (planner, orchestrator, developer, ...) for task agents. */
  role: string | null;
}

/** A simplified, UI-friendly view of a content block from an assistant/user message. */
export type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: TranscriptBlock[];
  timestamp: string;
}

export interface SessionDetail extends SessionSummary {
  transcript: TranscriptEntry[];
}

/** Request body for POST /api/sessions */
export interface CreateSessionRequest {
  projectId: string;
  prompt: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** Resume an existing Claude Code session id instead of starting fresh. */
  resumeSessionId?: string;
  title?: string;
}

/** Request body for POST /api/sessions/:id/messages */
export interface SendMessageRequest {
  prompt: string;
}

/** A session discovered on disk (~/.claude/projects) that isn't currently live. */
export interface StoredSession {
  claudeSessionId: string;
  cwd: string;
  firstPrompt: string;
  updatedAt: string;
}

/** Pending permission request from a running session. */
export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  createdAt: string;
}

/** Events pushed from server to all connected web clients over WebSocket. */
export type ServerEvent =
  | { type: 'projects.snapshot'; projects: Project[] }
  | { type: 'project.updated'; project: Project }
  | { type: 'project.removed'; projectId: string }
  | { type: 'sessions.snapshot'; sessions: SessionSummary[] }
  | { type: 'session.updated'; session: SessionSummary }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'session.entry'; sessionId: string; entry: TranscriptEntry }
  | { type: 'session.partial'; sessionId: string; entryId: string; text: string }
  | { type: 'permission.requested'; request: PermissionRequest }
  | { type: 'permission.resolved'; requestId: string; sessionId: string }
  | { type: 'tasks.snapshot'; tasks: Task[] }
  | { type: 'task.updated'; task: Task }
  | { type: 'task.removed'; taskId: string };

/** Response for GET /api/fs/dirs?path=... */
export interface DirectoryListing {
  path: string;
  /** null at the filesystem root */
  parent: string | null;
  dirs: { name: string; path: string; isGitRepo: boolean }[];
}

// --- Tasks -------------------------------------------------------------------
//
// A Task is one unit of work (feature, fix, change). The orchestrator is the
// user's interface: it sizes up the request (triage), then either hands it to
// a planner for an interactive planning phase or, for trivial work, writes a
// small plan itself and goes straight to execution. It then drives developer /
// reviewer / tester agents, and the task ends with a pull request plus a
// written report.

export type TaskPhase =
  | 'triage' // chatting with the orchestrator, which decides: plan first, or straight to work
  | 'planning' // chatting with the planner, plan not yet approved
  | 'executing' // orchestrator is driving agents
  | 'escalated' // orchestrator asked the user a question and is waiting
  | 'paused' // agents stopped (server restart or user pause); resumable
  | 'finishing' // pushing branch / opening PR
  | 'done' // PR opened (or report written when there is no remote)
  | 'failed'
  | 'cancelled';

export type WorkItemStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'testing'
  | 'needs_fix'
  | 'awaiting_user' // a design is with the user for approval or tweaks
  | 'blocked' // retry cap reached or otherwise needs the user
  | 'merged' // merged into the task branch
  | 'done';

export type WorkItemMode = 'worktree' | 'shared';

/**
 * code: implemented by a developer and merged into the task branch.
 * design: a designer mocks it up in the project UI on its own branch for the
 * user to approve; never merged, so the mock never reaches the PR.
 */
export type WorkItemKind = 'code' | 'design';

export interface WorkItemNote {
  at: string;
  by: string;
  text: string;
}

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  kind: WorkItemKind;
  /** worktree: own branch + worktree; shared: edits the task worktree directly. */
  mode: WorkItemMode;
  /** Suggested validators, e.g. ["reviewer", "tester"]. */
  validators: string[];
  status: WorkItemStatus;
  /** Number of times the item has been sent back for fixes. */
  attempts: number;
  notes: WorkItemNote[];
  branch: string | null;
  worktreePath: string | null;
}

export interface TaskPlan {
  /** Markdown spec: goal, scope, approach, out of scope. */
  spec: string;
  items: WorkItem[];
}

export type TaskAgentState = 'active' | 'reported' | 'closed';

export interface TaskAgent {
  /** Steffe session id (changes when an agent is resumed after a restart). */
  sessionId: string;
  /** Stable handle the orchestrator uses, e.g. "developer-1". */
  name: string;
  role: string;
  itemId: string | null;
  cwd: string;
  port: number | null;
  claudeSessionId: string | null;
  state: TaskAgentState;
  /** Has an assignment it hasn't reported on yet. */
  busy: boolean;
  /** Question asked with ask_orchestrator; the agent waits (still busy) until the orchestrator messages it. */
  pendingQuestion: string | null;
  /** The initial instructions, used to restart an agent that never initialised. */
  brief: string;
  lastReport: string | null;
  costUsd: number;
}

export interface TaskQuestion {
  id: string;
  text: string;
  /** Screenshots to show with the question (file names under GET /api/tasks/:id/artifacts/). */
  images?: string[];
  /** Live pages to open, e.g. a designer's mock running in the app on its private port. */
  links?: { label: string; url: string }[];
  askedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  /** The user's original request. */
  prompt: string;
  phase: TaskPhase;
  /** Phase to return to when resuming a paused task. */
  resumePhase: TaskPhase | null;
  model: string | null;
  plan: TaskPlan | null;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  agents: TaskAgent[];
  question: TaskQuestion | null;
  report: string | null;
  prUrl: string | null;
  lastError: string | null;
  /** Messages for the orchestrator that arrived while it was not running. */
  inbox: string[];
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
}

/** Response of DELETE /api/tasks/:id (query `branches=1` also deletes the task's branches and closes its open PR). */
export interface DeleteTaskResult {
  /** Cleanup steps that failed; the task itself is deleted regardless. */
  warnings: string[];
}

/** Request body for POST /api/tasks */
export interface CreateTaskRequest {
  projectId: string;
  prompt: string;
  title?: string;
  /** Default model for agents whose role does not pin one. */
  model?: string;
}

/** Request body for POST /api/tasks/:id/answer */
export interface AnswerTaskRequest {
  answer: string;
}

// --- Pull requests -------------------------------------------------------------

export type ChecksState = 'passing' | 'failing' | 'pending' | 'none';

export interface PullRequestInfo {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string;
  checks: ChecksState;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null */
  reviewDecision: string | null;
  mergeable: string | null;
  updatedAt: string;
  /** Steffe task that opened this PR, if any. */
  taskId: string | null;
}

/** Response for GET /api/projects/:id/prs */
export interface PullRequestListing {
  available: boolean;
  /** Why the list is unavailable (no gh, no GitHub remote, ...). */
  reason: string | null;
  prs: PullRequestInfo[];
}

export interface PullRequestCheck {
  name: string;
  /** passing / failing / pending / skipped */
  state: 'passing' | 'failing' | 'pending' | 'skipped';
  url: string | null;
}

/** Response for GET /api/projects/:id/prs/:number */
export interface PullRequestDetail extends PullRequestInfo {
  body: string;
  createdAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { path: string; additions: number; deletions: number }[];
  commits: { oid: string; headline: string }[];
  checkRuns: PullRequestCheck[];
  reviews: { author: string; state: string; submittedAt: string; body: string }[];
  labels: string[];
}

// --- Agents & skills catalog ----------------------------------------------------

/** steffe: roles/ and plugin/skills in the Steffe repo; project: <repo>/.claude/agents and .claude/skills */
export type CatalogSource = 'steffe' | 'project';

export interface CatalogEntry {
  kind: 'agent' | 'skill';
  source: CatalogSource;
  name: string;
  description: string;
  /** Absolute path of the definition file. */
  path: string;
  frontmatter: Record<string, string>;
  /** The instructions (markdown body after the frontmatter). */
  body: string;
  /** Whole file, for editing. */
  raw: string;
}

/** Request body for POST /api/projects/:id/catalog (create from a template) */
export interface CreateCatalogEntryRequest {
  kind: 'agent' | 'skill';
  source: CatalogSource;
  /** lowercase letters, digits and dashes */
  name: string;
  description: string;
}

/** Request body for PUT /api/projects/:id/catalog (overwrite an existing file) */
export interface SaveCatalogEntryRequest {
  kind: 'agent' | 'skill';
  source: CatalogSource;
  name: string;
  raw: string;
}

/** Response for GET /api/projects/:id/catalog */
export interface ProjectCatalog {
  agents: CatalogEntry[];
  skills: CatalogEntry[];
}
