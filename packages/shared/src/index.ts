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
  /** Accepted wiring of the project's own agents and skills into Steffe roles; applied to task agents. */
  setup?: ProjectSetup | null;
  /** The setup agent's latest proposal, waiting for the user to accept or dismiss it. */
  setupProposal?: ProjectSetup | null;
  /**
   * isolagent flavor the project's sessions run in (a microVM); null: on this machine.
   * Undefined until the user has chosen. A new project's setup agent waits for that choice.
   */
  isolagentFlavor?: string | null;
  /**
   * The `gh auth login` account the project's sandbox and Steffe's own gh calls (PRs) act as;
   * unset: gh's active account.
   */
  githubUser?: string | null;
  /** Git author email in the project's sandbox; unset: the global git config's. */
  gitEmail?: string | null;
  /** vCPUs of the project's sandbox; unset: isolagent's default. */
  sandboxCpus?: number | null;
  /** Memory of the project's sandbox in MiB; unset: isolagent's default. */
  sandboxMemMb?: number | null;
  /**
   * The user stopped the sandbox: until they start it again (Sandbox page), the project's
   * sessions and git run on this machine.
   */
  sandboxStopped?: boolean;
  /** The sandbox's Claude Code config dir on this machine (its session history), once it has run. */
  sandboxStateDir?: string | null;
}

/** Response for GET /api/github/accounts: the logins gh is signed in to on github.com. */
export interface GithubAccounts {
  accounts: string[];
}

/** Request body for PUT /api/projects/:id/account */
export interface SetAccountRequest {
  githubUser: string | null;
  gitEmail: string | null;
}

/** Request body for PUT /api/projects/:id/sandbox/resources; null: isolagent's default. */
export interface SetSandboxResourcesRequest {
  cpus: number | null;
  memMb: number | null;
}

// --- isolagent sandbox ---------------------------------------------------------

export interface IsolagentFlavor {
  name: string;
  /** claude, opencode or cursor. Steffe can only drive claude. */
  agent: string;
  imageBuilt: boolean;
  imageStale: boolean;
}

/** Response for GET /api/isolagent/flavors */
export interface FlavorListing {
  available: boolean;
  /** Why not (isolagent missing or too old). */
  reason: string | null;
  flavors: IsolagentFlavor[];
}

export type SandboxState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'approval' // the project's .isolagent.toml (or its flavor) changed: the user must approve it
  | 'build' // the flavor's image is missing or out of date
  | 'error';

/** The sandbox of a project that has a flavor. */
export interface SandboxStatus {
  projectId: string;
  /** isolagent instance name */
  name: string;
  state: SandboxState;
  /** Error, or what to do about `build`. */
  message: string | null;
  /** Set in state `approval`. */
  approval: { file: string; hash: string; diff: string } | null;
  /** Non-fatal, e.g. the image's Claude Code differs from the SDK's. */
  warning: string | null;
}

/** Request body for PUT /api/projects/:id/sandbox */
export interface SetFlavorRequest {
  flavor: string | null;
}

/** Request body for POST /api/projects */
export interface CreateProjectRequest {
  path: string;
  name?: string;
}

/** Response of POST /api/projects */
export interface OpenProjectResult {
  project: Project;
  /** First time this folder was opened. The setup agent starts once the user has chosen a sandbox (git repos only). */
  created: boolean;
}

// --- Project setup -------------------------------------------------------------
//
// When a project is first opened, a setup agent reads its Claude Code agents,
// skills, commands, MCP servers and CLAUDE.md, and proposes how Steffe's roles
// should use them. The user discusses it in chat and accepts it; from then on
// each task agent gets its role's wiring in its system prompt.

/** How one Steffe role uses the project's own agents and skills. */
export interface RoleWiring {
  /** Steffe role name (developer, tester, ...). */
  role: string;
  /** Project skills (.claude/skills) the role should use. */
  skills: string[];
  /** Project subagents (.claude/agents) the role should delegate to. */
  agents: string[];
  /** Markdown instructions for the role in this project: when and how to use them. */
  guidance: string;
}

export interface ProjectSetup {
  /** Markdown: what the project provides and the reasoning behind the wiring. */
  summary: string;
  roles: RoleWiring[];
  /** Agents or skills the project could add so Steffe's agents work better. */
  suggestions: string[];
  updatedAt: string;
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
  images?: ImageAttachment[];
}

/**
 * An image (e.g. a pasted screenshot) sent along with a message. It is passed
 * straight to the Claude session and not stored by Steffe.
 */
export interface ImageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64, without the data: URL prefix. */
  data: string;
  name: string;
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
  | { type: 'sandboxes.snapshot'; sandboxes: SandboxStatus[] }
  | { type: 'sandbox.updated'; sandbox: SandboxStatus }
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
  | 'review' // PR opened (or report written): the user tests it; changes reopen it (add_items)
  | 'done' // the user marked it done (tested, merged or otherwise closed)
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

/** queued: spawned, waiting for a free slot (STEFFE_MAX_AGENTS) before it starts. */
export type TaskAgentState = 'queued' | 'active' | 'reported' | 'closed';

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
  /** When the orchestrator spawned it (it may have waited in the queue before starting). */
  spawnedAt: string;
  /** When it was closed for good; null while it can still be messaged. */
  closedAt: string | null;
  /** Time spent working on turns, across restarts. */
  activeMs: number;
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
  plan: TaskPlan | null;
  baseBranch: string;
  branch: string;
  /**
   * The task worktree on `branch`. Null until the orchestrator starts work
   * (start_planning / start_work): a request it just answers never gets one.
   */
  worktreePath: string | null;
  /** Branch the user's main checkout was switched to by handoff (the task worktree is gone then). */
  handedOff: string | null;
  agents: TaskAgent[];
  question: TaskQuestion | null;
  report: string | null;
  prUrl: string | null;
  /**
   * Number of the existing pull request the task took over (checkout_pr), whose branch is the
   * task branch. finish leaves that PR's title and description alone and comments instead.
   */
  adoptedPr?: number;
  lastError: string | null;
  /** Messages for the orchestrator that arrived while it was not running. */
  inbox: string[];
  /** The latest retro of the task: one runs after every finish (see RetroRecord). */
  retro: TaskRetro | null;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
}

// --- Retros --------------------------------------------------------------------
//
// After every finish a facilitator agent looks back at the round: it reads the
// agents' transcripts and Steffe's numbers and records what took long, what
// failed and what was redone. Records are kept in <data dir>/retros/, one JSON
// file each, and outlive their task: they are there to be analysed across tasks.

export interface TaskRetro {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  /** The stored record (GET /api/tasks/:id/retro), once done. */
  recordId: string | null;
  error: string | null;
}

/**
 * slow: took much longer than it should have. failure: something broke (a command, the
 * environment, a tool, an agent). rework: done twice (fix rounds, misunderstood brief).
 * waste: effort that bought nothing. friction: a rule, prompt or missing piece of setup got in the way.
 */
export type RetroFindingKind = 'slow' | 'failure' | 'rework' | 'waste' | 'friction';

export interface RetroFinding {
  kind: RetroFindingKind;
  title: string;
  /** What happened, with the evidence (agent, time, command). */
  detail: string;
  agent: string | null;
  itemId: string | null;
  /** Rough time it cost. */
  minutes: number | null;
  /** What would prevent it: a change to a role, a skill, the project setup or the project itself. */
  suggestion: string | null;
}

export interface RetroAnalysis {
  /** Markdown, a few sentences: how the round went. */
  summary: string;
  rating: 'smooth' | 'bumpy' | 'rough';
  wentWell: string[];
  findings: RetroFinding[];
}

export interface RetroAgentMetrics {
  name: string;
  role: string;
  itemId: string | null;
  activeMs: number;
  costUsd: number;
  /** From spawn to its first message (time in the agent queue); null when unknown. */
  waitMs: number | null;
  toolCalls: number;
  toolErrors: number;
  /** Outcome of its last report (success, failure, blocked), if it reported. */
  outcome: string | null;
}

/** What Steffe measured itself, independent of the facilitator's reading. */
export interface RetroMetrics {
  /** From the task's creation to the retro. */
  wallMs: number;
  /** Agents' working time, summed. */
  activeMs: number;
  costUsd: number;
  fixRounds: number;
  toolCalls: number;
  toolErrors: number;
  agents: RetroAgentMetrics[];
  items: { id: string; title: string; kind: WorkItemKind; status: WorkItemStatus; fixRounds: number }[];
  /** The longest tool calls of the task, longest first. */
  slowest: { agent: string; tool: string; summary: string; seconds: number }[];
}

export interface RetroRecord {
  id: string;
  taskId: string;
  projectId: string;
  projectName: string;
  taskTitle: string;
  /** 1 for the first retro of a task; later ones follow a reopen (add_items) and another finish. */
  round: number;
  createdAt: string;
  metrics: RetroMetrics;
  analysis: RetroAnalysis;
  facilitator: { model: string | null; costUsd: number; activeMs: number };
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
  /** Sent to the orchestrator with the first message; not stored. */
  images?: ImageAttachment[];
}

/** Request body for POST /api/tasks/:id/message: the user writes to the orchestrator (restarted if it was stopped). */
export interface TaskMessageRequest {
  text: string;
  images?: ImageAttachment[];
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
