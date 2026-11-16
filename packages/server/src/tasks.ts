import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { DATA_DIR } from './dataDir.js';
import { writeFileAtomic } from './atomicWrite.js';
import type {
  CreateTaskRequest,
  Project,
  ServerEvent,
  Task,
  TaskAgent,
  TaskPhase,
  WorkItem,
  WorkItemStatus,
} from '@steffe/shared';
import { steffeServer, type PlanItemInput, type ToolHost } from './agentTools.js';
import {
  addWorktree,
  commitsAhead,
  defaultBaseBranch,
  isGitRepo,
  mergeBranch,
  removeWorktree,
  startPoint,
  statusPorcelain,
  tryGit,
} from './git.js';
import { closePullRequest, createPullRequest } from './github.js';
import { claimPort, releasePort, reservePort, stopListeners } from './ports.js';
import type { ProjectStore } from './projects.js';
import { PLUGIN_DIR, getRole, loadRoles } from './roles.js';
import type { ManagedSession } from './session.js';
import type { SessionManager } from './sessionManager.js';

const TASKS_DIR = join(DATA_DIR, 'tasks');
const WORKTREES_DIR = join(DATA_DIR, 'worktrees');

/** Validation failures before an item is blocked and the user is asked. */
const MAX_FIX_ROUNDS = 3;
/** Times the orchestrator may go idle with nothing in flight before we escalate. */
const MAX_NUDGES = 2;

const LIVE_PHASES: TaskPhase[] = ['triage', 'planning', 'executing', 'escalated', 'finishing'];
const SINGLETON_ROLES = new Set(['planner', 'orchestrator']);

/** Marker designers put on every mock change; finish refuses to open a PR while it is on the task branch. */
export const MOCK_MARKER = 'STEFFE-MOCK';
/** The marker's name before the Conductor -> Steffe rename; design branches from then may still carry it. */
const LEGACY_MOCK_MARKER = 'CONDUCTOR-MOCK';

/** Screenshots and other files agents hand over (served by GET /api/tasks/:id/artifacts/:name). */
export const artifactsDir = (taskId: string) => join(WORKTREES_DIR, taskId, 'artifacts');

const playwrightMcp = (outputDir: string) => ({
  type: 'stdio' as const,
  command: 'npx',
  // --isolated: in-memory profile, so parallel testers don't fight over one browser.
  args: ['-y', '@playwright/mcp@latest', '--isolated', '--headless', '--output-dir', outputDir],
});

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'task'
  );
}

const now = () => new Date().toISOString();

const newItem = (i: PlanItemInput): WorkItem => ({
  ...i,
  status: 'todo',
  attempts: 0,
  notes: [],
  branch: null,
  worktreePath: null,
});

/**
 * Owns Tasks: persistence, git worktrees, and the agents (ManagedSessions)
 * working on them. The orchestrator is the hub and the user's interface: it
 * triages each new request (planner first, or straight to a developer), and
 * every subagent report is delivered to it as a new user message.
 */
export class TaskManager {
  private readonly tasks = new Map<string, Task>();
  /** agent name -> live session, per task */
  private readonly live = new Map<string, Map<string, ManagedSession>>();
  /** cost already accounted for an agent before its current session (resumes start at 0) */
  private readonly carriedCost = new Map<string, number>();
  private readonly nudges = new Map<string, number>();
  private readonly saveTimers = new Map<string, NodeJS.Timeout>();
  /** Tasks whose orchestrator just called finish: it is stopped when that turn ends. Later chats keep it running. */
  private readonly finishing = new Set<string>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly projects: ProjectStore,
  ) {}

  private emit(event: ServerEvent): void {
    this.sessions.broadcast(event);
  }

  // --- persistence ---------------------------------------------------------

  async load(): Promise<void> {
    await mkdir(TASKS_DIR, { recursive: true });
    for (const f of await readdir(TASKS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const task = JSON.parse(await readFile(join(TASKS_DIR, f), 'utf8')) as Task;
        task.inbox ??= [];
        task.handedOff ??= null;
        for (const a of task.agents) a.pendingQuestion ??= null;
        for (const item of task.plan?.items ?? []) item.kind ??= 'code';
        // Nothing survives a restart: everything that was live is now paused.
        if (LIVE_PHASES.includes(task.phase)) {
          task.resumePhase = task.phase;
          task.phase = 'paused';
        }
        for (const a of task.agents) if (a.port != null && a.state !== 'closed') claimPort(a.port);
        this.tasks.set(task.id, task);
        await this.persist(task);
      } catch (err) {
        // Set it aside so it isn't retried (and reported) on every start.
        const aside = join(TASKS_DIR, `${f}.corrupt`);
        await rename(join(TASKS_DIR, f), aside).catch(() => {});
        console.error(`[steffe] could not load task ${f}, moved to ${aside}:`, err);
      }
    }
  }

  private async persist(task: Task): Promise<void> {
    await mkdir(TASKS_DIR, { recursive: true });
    await writeFileAtomic(join(TASKS_DIR, `${task.id}.json`), JSON.stringify(task, null, 2));
  }

  /** Sync live session state into the task, emit, and schedule a save. */
  private changed(task: Task): void {
    const live = this.live.get(task.id);
    let cost = 0;
    for (const a of task.agents) {
      const s = live?.get(a.name);
      if (s) {
        a.claudeSessionId = s.claudeSessionId ?? a.claudeSessionId;
        a.costUsd = (this.carriedCost.get(`${task.id}:${a.name}`) ?? 0) + s.totalCostUsd;
      }
      cost += a.costUsd;
    }
    task.totalCostUsd = cost;
    task.updatedAt = now();
    this.emit({ type: 'task.updated', task });
    clearTimeout(this.saveTimers.get(task.id));
    this.saveTimers.set(
      task.id,
      setTimeout(() => {
        this.saveTimers.delete(task.id);
        void this.persist(task).catch((err) => console.error('[steffe] task save failed:', err));
      }, 200),
    );
  }

  /** Write every task now (shutdown). */
  async flush(): Promise<void> {
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this.saveTimers.clear();
    for (const task of this.tasks.values()) await this.persist(task);
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  taskForBranch(branch: string): string | null {
    for (const t of this.tasks.values()) if (t.branch === branch) return t.id;
    return null;
  }

  private must(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new Error('task not found');
    return t;
  }

  private project(task: Task): Project {
    const p = this.projects.get(task.projectId);
    if (!p) throw new Error('project not found');
    return p;
  }

  // --- lifecycle -----------------------------------------------------------

  async create(req: CreateTaskRequest): Promise<Task> {
    const project = this.projects.get(req.projectId);
    if (!project) throw new Error('project not found');
    if (!(await isGitRepo(project.path))) throw new Error('tasks need a git repository');
    const id = randomUUID();
    const title = (req.title?.trim() || req.prompt.split('\n')[0]).slice(0, 80);
    const baseBranch = await defaultBaseBranch(project.path);
    // Only the name: the branch and its worktree are created when the orchestrator starts work.
    const branch = `steffe/${slugify(title)}-${id.slice(0, 6)}`;

    const task: Task = {
      id,
      projectId: project.id,
      title,
      prompt: req.prompt,
      phase: 'triage',
      resumePhase: null,
      model: req.model ?? null,
      plan: null,
      baseBranch,
      branch,
      worktreePath: null,
      handedOff: null,
      agents: [],
      question: null,
      report: null,
      prUrl: null,
      lastError: null,
      inbox: [],
      totalCostUsd: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    this.tasks.set(id, task);
    await this.persist(task);
    const prompt = [
      `[steffe] New message from the user. If it is a question or a request to look into something, answer it in chat: you are in the user's main checkout, read only, and no worktree exists yet. If it asks for changes, triage it: hand it to a planner (start_planning) or, if it is trivial, set a small plan and go straight to a developer (start_work). Either one creates the task branch and worktree.`,
      ``,
      `# Task: ${title}`,
      ``,
      `## Request`,
      req.prompt,
      ``,
      await this.rolesText(),
    ].join('\n');
    await this.startAgent(task, 'orchestrator', { cwd: project.path, itemId: null, prompt });
    this.changed(task);
    return task;
  }

  /** Create the task branch and worktree the first time work starts. */
  private async ensureWorktree(task: Task): Promise<string> {
    if (task.worktreePath) return task.worktreePath;
    const project = this.project(task);
    const path = join(WORKTREES_DIR, task.id, 'task');
    await addWorktree(project.path, path, task.branch, await startPoint(project.path, task.baseBranch));
    task.worktreePath = path;
    return path;
  }

  private worktree(task: Task): string {
    if (!task.worktreePath) throw new Error('no work has started on this task (start_planning or start_work creates its worktree)');
    return task.worktreePath;
  }

  private async rolesText(): Promise<string> {
    const roles = [...(await loadRoles()).values()].filter((r) => !SINGLETON_ROLES.has(r.name));
    return [`## Roles you can spawn`, ...roles.map((r) => `- **${r.name}**: ${r.description}`)].join('\n');
  }

  /** End planning: the planner is done and the task executes the plan. Returns the plan as a brief for the orchestrator. */
  private async approvePlan(task: Task): Promise<string> {
    if (task.phase !== 'planning') throw new Error(`task is ${task.phase}, not planning`);
    if (!task.plan?.items.length) throw new Error('the plan has no work items yet');
    await this.stopAgent(task, 'planner');
    task.phase = 'executing';
    return [
      `# Task: ${task.title}`,
      ``,
      `## Original request`,
      task.prompt,
      ``,
      `## Spec`,
      task.plan.spec,
      ``,
      `## Work items`,
      '```json',
      JSON.stringify(
        task.plan.items.map(({ id, title, description, acceptanceCriteria, dependsOn, mode, validators }) => ({
          id,
          title,
          description,
          acceptanceCriteria,
          dependsOn,
          mode,
          validators,
        })),
        null,
        2,
      ),
      '```',
      ``,
      await this.rolesText(),
    ].join('\n');
  }

  /** The user approved the plan with the UI button; the orchestrator executes it. */
  async approve(id: string): Promise<Task> {
    const task = this.must(id);
    const prompt = `[steffe] The user approved the plan in the UI. Execute it.\n\n${await this.approvePlan(task)}`;
    const orch = task.agents.find((a) => a.name === 'orchestrator');
    const live = this.live.get(task.id)?.get('orchestrator');
    if (live && live.status !== 'ended' && live.status !== 'error') {
      this.toOrchestrator(task, prompt);
    } else if (orch) {
      await this.restartAgent(task, orch, prompt);
      if (!orch.claudeSessionId) this.live.get(task.id)?.get('orchestrator')?.send(prompt);
    } else {
      // Tasks created before triage existed have no orchestrator yet.
      await this.startAgent(task, 'orchestrator', { cwd: this.worktree(task), itemId: null, prompt });
    }
    this.changed(task);
    return task;
  }

  async answer(id: string, answer: string): Promise<Task> {
    const task = this.must(id);
    if (!task.question) throw new Error('no pending question');
    const q = task.question;
    task.question = null;
    if (task.phase === 'escalated') task.phase = 'executing';
    // The user weighed in: blocked items get a fresh set of fix rounds.
    for (const item of task.plan?.items ?? []) {
      if (item.status === 'blocked') {
        item.status = 'needs_fix';
        item.attempts = 0;
      }
    }
    this.toOrchestrator(task, `[steffe] The user answered your question.\n\nQuestion: ${q.text}\n\nAnswer: ${answer}`);
    this.changed(task);
    return task;
  }

  /**
   * The user writes to the orchestrator. Works in any phase but paused: a stopped orchestrator
   * (finished or cancelled task, or after a restart) is resumed with the message.
   */
  async message(id: string, text: string): Promise<Task> {
    const task = this.must(id);
    if (task.phase === 'paused') throw new Error('the task is paused: resume it first');
    const orch = task.agents.find((a) => a.role === 'orchestrator');
    if (!orch) throw new Error('this task has no orchestrator');
    const live = this.live.get(task.id)?.get(orch.name);
    if (live && live.status !== 'ended' && live.status !== 'error') {
      live.send(text);
    } else {
      const ended = !LIVE_PHASES.includes(task.phase);
      const notes = ended
        ? [
            `[steffe] The task is ${task.phase}${task.handedOff ? ` and handed off: the user's main checkout is on ${task.handedOff} and the task worktree is gone` : ''}. No other agents are running. The user is writing to you again: answer in chat.`,
            ...task.inbox.splice(0),
          ]
        : [];
      const body = [...notes, notes.length ? `The user's message:\n\n${text}` : text].join('\n\n---\n\n');
      await this.restartAgent(task, orch, body);
      if (!orch.claudeSessionId) this.live.get(task.id)?.get(orch.name)?.send(body);
    }
    this.changed(task);
    return task;
  }

  /**
   * Hand a finished task to the user for local testing: remove its worktrees and check the
   * branch out in the main checkout. Refuses when either checkout has uncommitted changes.
   */
  async handoff(id: string): Promise<Task> {
    const task = this.must(id);
    if (LIVE_PHASES.includes(task.phase) || task.phase === 'paused') {
      throw new Error(`task is ${task.phase}: hand off a finished task (or cancel it first)`);
    }
    if (!task.worktreePath) throw new Error(task.handedOff ? `already handed off (${task.handedOff})` : 'the task has no branch yet');
    const project = this.project(task);
    const items = task.plan?.items ?? [];
    // A design-only task leaves its mock on the design branch, not the task branch.
    const designOnly = items.length > 0 && items.every((i) => i.kind === 'design');
    const branch = (designOnly && items.find((i) => i.branch)?.branch) || task.branch;

    const mainDirty = await tryGit(project.path, 'status', '--porcelain', '--untracked-files=no');
    if (!mainDirty.ok) throw new Error(`git status failed in ${project.path}: ${mainDirty.out}`);
    if (mainDirty.out) throw new Error(`your main checkout has uncommitted changes; commit or stash them first:\n${mainDirty.out}`);
    const worktrees = [task.worktreePath, ...items.map((i) => i.worktreePath).filter((p): p is string => !!p)];
    for (const wt of worktrees) {
      const dirty = await tryGit(wt, 'status', '--porcelain');
      if (dirty.ok && dirty.out) throw new Error(`${wt} has uncommitted changes that would be lost:\n${dirty.out}`);
    }

    // Agents' apps (dev servers) run from the worktrees; stop them first.
    for (const a of task.agents) if (a.role !== 'orchestrator' && a.state !== 'closed') await this.stopAgent(task, a.name);
    for (const item of items) {
      if (item.worktreePath) {
        await removeWorktree(project.path, item.worktreePath);
        item.worktreePath = null;
      }
    }
    await removeWorktree(project.path, task.worktreePath);
    task.worktreePath = null;
    this.changed(task);
    const co = await tryGit(project.path, 'checkout', branch);
    if (!co.ok) throw new Error(`the worktrees are removed, but checking out ${branch} failed:\n${co.out}`);
    task.handedOff = branch;
    this.changed(task);
    return task;
  }

  /** Stop every agent but keep their sessions resumable. */
  async pause(id: string): Promise<Task> {
    const task = this.must(id);
    if (!LIVE_PHASES.includes(task.phase)) throw new Error(`task is ${task.phase}`);
    task.resumePhase = task.phase;
    task.phase = 'paused';
    for (const name of [...(this.live.get(task.id)?.keys() ?? [])]) this.detach(task, name);
    this.changed(task);
    return task;
  }

  async resume(id: string): Promise<Task> {
    const task = this.must(id);
    if (task.phase !== 'paused') throw new Error(`task is ${task.phase}, not paused`);
    const phase = task.resumePhase ?? 'triage';
    task.phase = phase;
    task.resumePhase = null;
    task.lastError = null;
    const restartNote =
      '[steffe] Steffe was restarted while you were working. Check the state of your working directory, continue your assignment, and call report when done.';

    if (phase === 'triage') {
      // Only the orchestrator exists and it is talking with the user: bring it back idle.
      const orch = task.agents.find((a) => a.role === 'orchestrator');
      if (orch) await this.restartAgent(task, orch, null);
    } else {
      for (const a of task.agents) {
        if (a.role === 'orchestrator' || a.state !== 'active') continue;
        await this.restartAgent(task, a, a.busy && !a.pendingQuestion ? restartNote : null);
      }
      const orch = task.agents.find((a) => a.role === 'orchestrator');
      if (orch) {
        const working = task.agents.filter((a) => a.state === 'active' && a.busy && !a.pendingQuestion && a.role !== 'orchestrator');
        const waiting = task.agents.filter((a) => a.state === 'active' && a.pendingQuestion);
        const lines = [
          '[steffe] Steffe was restarted and the task has been resumed.',
          working.length
            ? `These agents were mid-assignment and have been told to continue: ${working.map((a) => a.name).join(', ')}. Their reports will arrive as usual.`
            : 'No agents were mid-assignment.',
          ...waiting.map((a) => `${a.name} is waiting for your answer (message_agent) to: ${a.pendingQuestion}`),
          phase === 'finishing' ? 'You were finishing the task: call finish again.' : '',
          task.question ? `Your question to the user is still pending: ${task.question.text}` : '',
          task.inbox.length ? `Messages that arrived while you were stopped:\n\n${task.inbox.splice(0).join('\n\n---\n\n')}` : '',
          'Check task_status and continue.',
        ];
        await this.restartAgent(task, orch, lines.filter(Boolean).join('\n'));
      }
    }
    this.changed(task);
    return task;
  }

  async cancel(id: string): Promise<Task> {
    const task = this.must(id);
    for (const name of [...(this.live.get(task.id)?.keys() ?? [])]) await this.stopAgent(task, name);
    task.phase = 'cancelled';
    this.changed(task);
    return task;
  }

  /**
   * Forget a task and remove its worktrees. Branches and any PR are kept unless `deleteBranches`:
   * then the open PR is closed and the task and item branches are deleted locally and on origin.
   * Returns null when the task does not exist, else the cleanup steps that failed.
   */
  async remove(id: string, opts: { deleteBranches?: boolean } = {}): Promise<{ warnings: string[] } | null> {
    const task = this.tasks.get(id);
    if (!task) return null;
    const warnings: string[] = [];
    for (const name of [...(this.live.get(task.id)?.keys() ?? [])]) await this.stopAgent(task, name);
    for (const a of task.agents) {
      const s = this.sessions.get(a.sessionId);
      if (s) this.sessions.remove(s.id);
    }
    const project = this.projects.get(task.projectId);
    if (project) {
      for (const item of task.plan?.items ?? []) {
        if (item.worktreePath) await removeWorktree(project.path, item.worktreePath);
      }
      if (task.worktreePath) await removeWorktree(project.path, task.worktreePath);
      // Without a worktree (or a handoff) the task branch was never created.
      if (opts.deleteBranches && (task.worktreePath || task.handedOff)) warnings.push(...(await this.deleteBranches(project.path, task)));
    }
    await rm(join(WORKTREES_DIR, task.id), { recursive: true, force: true });
    await rm(join(TASKS_DIR, `${task.id}.json`), { force: true });
    this.tasks.delete(id);
    this.live.delete(id);
    this.emit({ type: 'task.removed', taskId: id });
    return { warnings };
  }

  /** Close the task's open PR and delete its branches locally and on origin. Returns what failed. */
  private async deleteBranches(repo: string, task: Task): Promise<string[]> {
    const warnings: string[] = [];
    const branches = [task.branch, ...(task.plan?.items ?? []).map((i) => i.branch).filter((b): b is string => !!b)];
    const hasOrigin = (await tryGit(repo, 'remote', 'get-url', 'origin')).ok;
    if (hasOrigin) {
      try {
        await closePullRequest(repo, task.branch, 'Closed by Steffe: the task was deleted.');
      } catch (e) {
        const err = e as { stderr?: string; message: string };
        warnings.push(`closing the PR for ${task.branch} failed: ${(err.stderr || err.message).trim()}`);
      }
      const remote = await tryGit(repo, 'ls-remote', '--heads', 'origin', ...branches);
      if (!remote.ok) warnings.push(`listing branches on origin failed: ${remote.out}`);
      const onRemote = remote.ok ? branches.filter((b) => remote.out.split('\n').some((l) => l.endsWith(`\trefs/heads/${b}`))) : [];
      if (onRemote.length) {
        const push = await tryGit(repo, 'push', 'origin', '--delete', ...onRemote);
        if (!push.ok) warnings.push(`deleting ${onRemote.join(', ')} on origin failed: ${push.out.trim()}`);
      }
    }
    for (const b of branches) {
      if (!(await tryGit(repo, 'rev-parse', '--verify', `refs/heads/${b}`)).ok) continue;
      const del = await tryGit(repo, 'branch', '-D', b);
      if (!del.ok) warnings.push(`deleting local branch ${b} failed: ${del.out.trim()}`);
    }
    return warnings;
  }

  closeAll(): void {
    for (const task of this.tasks.values()) {
      for (const name of [...(this.live.get(task.id)?.keys() ?? [])]) this.detach(task, name);
    }
  }

  // --- agents --------------------------------------------------------------

  private nextName(task: Task, role: string): string {
    if (SINGLETON_ROLES.has(role)) return role;
    let n = 1;
    while (task.agents.some((a) => a.name === `${role}-${n}`)) n++;
    return `${role}-${n}`;
  }

  private async startAgent(
    task: Task,
    roleName: string,
    opts: { cwd: string; itemId: string | null; prompt: string },
  ): Promise<TaskAgent> {
    const role = await getRole(roleName);
    const existing = SINGLETON_ROLES.has(roleName) ? task.agents.find((a) => a.name === roleName) : undefined;
    const agent: TaskAgent = existing ?? {
      sessionId: '',
      name: this.nextName(task, roleName),
      role: roleName,
      itemId: opts.itemId,
      cwd: opts.cwd,
      port: role.port ? await reservePort() : null,
      claudeSessionId: null,
      state: 'active',
      busy: true,
      pendingQuestion: null,
      brief: opts.prompt,
      lastReport: null,
      costUsd: 0,
    };
    if (!existing) task.agents.push(agent);
    await this.launch(task, agent, { prompt: opts.prompt, resume: null });
    return agent;
  }

  /** Bring a persisted agent back: resume its Claude session if it has one, else start over from its brief. */
  private async restartAgent(task: Task, agent: TaskAgent, message: string | null): Promise<void> {
    if (agent.claudeSessionId) {
      await this.launch(task, agent, { prompt: message ?? '', resume: agent.claudeSessionId });
    } else {
      await this.launch(task, agent, { prompt: agent.brief, resume: null });
    }
  }

  private async launch(task: Task, agent: TaskAgent, opts: { prompt: string; resume: string | null }): Promise<void> {
    const role = await getRole(agent.role);
    const project = this.project(task);
    const old = this.sessions.get(agent.sessionId);
    if (old) this.sessions.remove(old.id);
    // A role may gain `port: true` after the agent was created (e.g. a resumed planner).
    if (role.port && agent.port == null) agent.port = await reservePort();
    if (agent.port != null) claimPort(agent.port);
    this.carriedCost.set(`${task.id}:${agent.name}`, agent.costUsd);
    const artifacts = artifactsDir(task.id);
    await mkdir(artifacts, { recursive: true });

    const item = agent.itemId ? task.plan?.items.find((i) => i.id === agent.itemId) : undefined;
    const context = [
      '',
      '## This Steffe task',
      `- Task: ${task.title}`,
      `- You are: **${agent.name}** (role ${agent.role})${item ? `, working on item \`${item.id}\` (${item.title})` : ''}`,
      `- Working directory: ${agent.cwd}`,
      `- Task branch: ${task.branch} (base: ${task.baseBranch})${item?.branch ? `; your item branch: ${item.branch}` : ''}`,
      `- Task worktree: ${task.worktreePath ?? 'none yet (start_planning or start_work creates it)'}`,
      agent.port != null ? `- Your private port: ${agent.port} (env PORT; ${agent.port + 1}-${agent.port + 9} are yours too)` : '',
      agent.cwd === project.path
        ? `- Your working directory is the user's main checkout: read only. Don't edit it, switch branches, run the app from it, or touch anything running from it.`
        : `- The user's main checkout at ${project.path} is off-limits: don't edit it, run things from it, or touch anything running from it.`,
      `- Files to hand over (screenshots): ${artifacts} (env STEFFE_ARTIFACTS). Playwright screenshots are saved there.`,
      `- Steffe tools are named mcp__steffe__<tool>.`,
    ]
      .filter(Boolean)
      .join('\n');

    const allowed = [...role.tools];
    const session = this.sessions.create(
      {
        projectId: task.projectId,
        prompt: opts.prompt,
        // STEFFE_FORCE_MODEL (e.g. haiku) overrides every role, for cheap smoke tests.
        model: process.env.STEFFE_FORCE_MODEL || role.model || task.model || undefined,
        permissionMode: 'default',
        resumeSessionId: opts.resume ?? undefined,
        title: `${agent.name} · ${task.title}`,
      },
      agent.cwd,
      {
        taskId: task.id,
        role: agent.role,
        systemPromptAppend: `${role.prompt}\n${context}`,
        mcpServers: {
          steffe: steffeServer(this.toolHost(task.id, agent.name), allowed),
          ...(role.mcp.includes('playwright') ? { playwright: playwrightMcp(artifacts) } : {}),
        },
        disallowedTools: role.disallowedTools,
        env: {
          ...(agent.port != null ? { PORT: String(agent.port) } : {}),
          STEFFE_TASK_ID: task.id,
          STEFFE_AGENT: agent.name,
          STEFFE_ARTIFACTS: artifacts,
        },
        plugins: [PLUGIN_DIR],
        writableRoots: role.writable === 'cwd' ? [agent.cwd] : [],
        onTurnEnd: (s) => this.onTurnEnd(task.id, agent.name, s),
        onExit: (s) => this.onExit(task.id, agent.name, s),
      },
    );
    agent.sessionId = session.id;
    agent.state = 'active';
    let live = this.live.get(task.id);
    if (!live) this.live.set(task.id, (live = new Map()));
    live.set(agent.name, session);
  }

  /** Drop a live session without changing the agent's state (pause / shutdown). */
  private detach(task: Task, name: string): void {
    const s = this.live.get(task.id)?.get(name);
    this.live.get(task.id)?.delete(name);
    this.syncFrom(task, name, s);
    s?.close();
  }

  /** The agent is done for good. */
  private async stopAgent(task: Task, name: string): Promise<void> {
    this.detach(task, name);
    const agent = task.agents.find((a) => a.name === name);
    if (!agent) return;
    agent.state = 'closed';
    agent.busy = false;
    agent.pendingQuestion = null;
    // Apps the agent left running (a designer's live mock) go with it.
    const stopped = await stopListeners(agent.port);
    if (stopped.length) console.log(`[steffe] stopped ${name}'s processes on port ${agent.port}: ${stopped.join(', ')}`);
    releasePort(agent.port);
  }

  private syncFrom(task: Task, name: string, s: ManagedSession | undefined): void {
    const a = task.agents.find((x) => x.name === name);
    if (!a || !s) return;
    a.claudeSessionId = s.claudeSessionId ?? a.claudeSessionId;
    a.costUsd = (this.carriedCost.get(`${task.id}:${name}`) ?? 0) + s.totalCostUsd;
  }

  private onTurnEnd(taskId: string, name: string, s: ManagedSession): void {
    const task = this.tasks.get(taskId);
    const agent = task?.agents.find((a) => a.name === name);
    if (!task || !agent || this.live.get(taskId)?.get(name) !== s) return;

    if (agent.role === 'orchestrator') {
      if (task.phase === 'done' && this.finishing.delete(taskId)) {
        // Free the process; the user can still message it, which resumes it.
        void this.stopAgent(task, name).then(() => this.changed(task));
        return;
      }
      if (task.inbox.length) {
        this.toOrchestrator(task, task.inbox.splice(0).join('\n\n---\n\n'));
      } else if (
        task.phase === 'executing' &&
        !task.question &&
        !task.agents.some((a) => a.busy && !a.pendingQuestion && a.role !== 'orchestrator')
      ) {
        // Idle with nothing in flight (agents waiting on an answer from it don't count): it forgot to answer, dispatch or finish.
        const n = (this.nudges.get(taskId) ?? 0) + 1;
        this.nudges.set(taskId, n);
        if (n <= MAX_NUDGES) {
          const waiting = task.agents.filter((a) => a.pendingQuestion);
          s.send(
            waiting.length
              ? `[steffe] These agents are waiting for your answer, and nothing else will wake you up. Answer each with message_agent (or ask_user first if only the user can decide):\n\n${waiting.map((a) => `- ${a.name}: ${a.pendingQuestion}`).join('\n')}`
              : '[steffe] No agents are working and no question is pending, so nothing will wake you up. Dispatch the next work, ask_user if you are blocked, or call finish if everything is merged.',
          );
        } else {
          task.phase = 'escalated';
          task.question = {
            id: randomUUID(),
            text: `The orchestrator stopped without dispatching work or finishing. Its last message:\n\n${s.lastAssistantText}`,
            askedAt: now(),
          };
        }
      }
    } else if (agent.role !== 'orchestrator' && agent.busy && !agent.pendingQuestion) {
      // Ended its turn without calling report: forward what it said so the hub isn't left waiting.
      agent.busy = false;
      agent.state = 'reported';
      agent.lastReport = `(no report) ${s.lastAssistantText}`;
      this.toOrchestrator(
        task,
        `[steffe] ${this.who(task, agent)} ended its turn without calling report. Its last message:\n\n${s.lastAssistantText || '(empty)'}`,
      );
    }
    this.changed(task);
  }

  private onExit(taskId: string, name: string, s: ManagedSession): void {
    const task = this.tasks.get(taskId);
    const agent = task?.agents.find((a) => a.name === name);
    if (!task || !agent || this.live.get(taskId)?.get(name) !== s) return; // closed on purpose
    this.live.get(taskId)?.delete(name);
    this.syncFrom(task, name, s);
    if (s.status !== 'error') return this.changed(task);
    if (agent.role === 'orchestrator') {
      task.resumePhase = task.phase;
      task.phase = 'paused';
      task.lastError = `${agent.name} crashed: ${s.lastError ?? 'unknown error'}. Resume the task to retry.`;
    } else {
      agent.busy = false;
      agent.pendingQuestion = null;
      agent.state = 'reported';
      this.toOrchestrator(
        task,
        `[steffe] ${this.who(task, agent)} crashed: ${s.lastError ?? 'unknown error'}. You can message_agent it to resume, or spawn a new one.`,
      );
    }
    this.changed(task);
  }

  private who(task: Task, agent: TaskAgent): string {
    return `${agent.name}${agent.itemId ? ` (item ${agent.itemId})` : ''}`;
  }

  private toOrchestrator(task: Task, text: string): void {
    this.nudges.set(task.id, 0);
    const orch = this.live.get(task.id)?.get('orchestrator');
    if (orch && (orch.status === 'idle' || orch.status === 'running' || orch.status === 'starting')) {
      orch.send(text);
    } else {
      task.inbox.push(text);
    }
  }

  // --- tools ---------------------------------------------------------------

  private toolHost(taskId: string, caller: string): ToolHost {
    const task = () => this.must(taskId);
    const run = async (fn: (t: Task) => Promise<string> | string) => {
      const t = task();
      try {
        return await fn(t);
      } finally {
        this.changed(t);
      }
    };
    return {
      updatePlan: (spec, items) =>
        run((t) => {
          if (t.phase !== 'planning') throw new Error('the plan is already approved; it can no longer be replaced');
          this.setPlan(t, spec, items);
          return `Plan updated: ${items.length} items. The user sees it on the board and approves it in the UI.`;
        }),
      startPlanning: (brief) => run((t) => this.startPlanning(t, brief)),
      approvePlan: () =>
        run(async (t) => `Plan approved; the task is now executing. Execute it:\n\n${await this.approvePlan(t)}`),
      addItems: (items) => run((t) => this.addItems(t, items)),
      startWork: (spec, items) =>
        run(async (t) => {
          if (t.phase !== 'triage') throw new Error(`start_work is a triage decision; the task is ${t.phase}`);
          if (!items.length) throw new Error('the plan needs at least one work item');
          this.setPlan(t, spec, items);
          const wt = await this.ensureWorktree(t);
          t.phase = 'executing';
          return `Plan set with ${items.length} item(s) and the task worktree created at ${wt} on ${t.branch}; the task is now executing. Spawn the developer(s) now.`;
        }),
      spawnAgent: (role, itemId, brief) => run((t) => this.spawnAgent(t, role, itemId, brief)),
      messageAgent: (name, text) => run((t) => this.messageAgent(t, name, text)),
      closeAgent: (name) =>
        run(async (t) => {
          if (name === caller) throw new Error('cannot close yourself');
          if (!t.agents.some((a) => a.name === name)) throw new Error(`no agent named ${name}`);
          await this.stopAgent(t, name);
          return `${name} closed.`;
        }),
      updateItem: (itemId, status, note) => run((t) => this.updateItem(t, caller, itemId, status as WorkItemStatus, note)),
      mergeItem: (itemId) => run((t) => this.mergeItem(t, itemId)),
      taskStatus: () => run((t) => this.statusText(t)),
      askUser: (question, images, links) =>
        run(async (t) => {
          if (t.phase === 'triage' || t.phase === 'planning') {
            throw new Error(`you are talking with the user directly during ${t.phase}: ask in your reply and end your turn`);
          }
          const dir = artifactsDir(t.id);
          const names: string[] = [];
          for (const img of images) {
            const rel = relative(dir, img.startsWith('/') ? img : join(dir, img));
            if (!rel || rel.startsWith('..') || rel.includes(sep)) throw new Error(`${img} is not a file directly in ${dir}`);
            const ok = await stat(join(dir, rel)).then((st) => st.isFile(), () => false);
            if (!ok) throw new Error(`${img} does not exist`);
            names.push(basename(rel));
          }
          for (const l of links) {
            let u: URL;
            try {
              u = new URL(l.url);
            } catch {
              throw new Error(`${l.url} is not a URL`);
            }
            if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error(`${l.url}: links must point at a local app (localhost)`);
          }
          t.question = {
            id: randomUUID(),
            text: question,
            askedAt: now(),
            ...(names.length ? { images: names } : {}),
            ...(links.length ? { links } : {}),
          };
          t.phase = 'escalated';
          return 'Question sent to the user. End your turn now; the answer will arrive as a [steffe] message.';
        }),
      finish: (prTitle, report, draft) => run((t) => this.finish(t, prTitle, report, draft)),
      askOrchestrator: (question) =>
        run((t) => {
          const agent = t.agents.find((a) => a.name === caller)!;
          if (!agent.busy) throw new Error('you have no assignment in progress');
          agent.pendingQuestion = question;
          this.toOrchestrator(
            t,
            `[steffe] Question from ${this.who(t, agent)}, role ${agent.role}. It is waiting for your answer: reply with message_agent("${agent.name}", ...), after ask_user if only the user can decide.\n\n${question}`,
          );
          return 'Question sent to the orchestrator. End your turn now; the answer arrives as a new message. Do not call report until your assignment is done.';
        }),
      report: (outcome, summary) =>
        run(async (t) => {
          const agent = t.agents.find((a) => a.name === caller)!;
          const designItem = agent.role === 'designer' && agent.itemId ? t.plan?.items.find((i) => i.id === agent.itemId) : undefined;
          if (outcome === 'success' && designItem?.branch && designItem.worktreePath) {
            // The mock must stay on the design branch: developers build from it and tweak rounds continue from it.
            const dirty = await statusPorcelain(designItem.worktreePath);
            if (dirty) throw new Error(`commit your mock on ${designItem.branch} (don't revert it), then report again:\n${dirty}`);
            if ((await commitsAhead(designItem.worktreePath, t.branch, designItem.branch)) === 0) {
              throw new Error(`${designItem.branch} has no commits: the mock must stay committed on your branch (don't revert it). Rebuild it if you reverted it, commit, and report again.`);
            }
          }
          agent.busy = false;
          agent.pendingQuestion = null;
          agent.state = 'reported';
          agent.lastReport = `${outcome}: ${summary}`;
          const item = agent.itemId ? t.plan?.items.find((i) => i.id === agent.itemId) : undefined;
          item?.notes.push({ at: now(), by: caller, text: `${outcome}: ${summary.slice(0, 500)}` });
          this.toOrchestrator(t, `[steffe] Report from ${this.who(t, agent)}, role ${agent.role}: **${outcome}**\n\n${summary}`);
          return 'Report delivered to the orchestrator. End your turn now.';
        }),
    };
  }

  private async startPlanning(task: Task, brief: string): Promise<string> {
    if (task.phase !== 'triage') throw new Error(`start_planning is a triage decision; the task is ${task.phase}`);
    const cwd = await this.ensureWorktree(task);
    task.phase = 'planning';
    await this.startAgent(task, 'planner', {
      cwd,
      itemId: null,
      prompt: [
        `The orchestrator handed you this task. Turn it into a plan. You work unattended: ask the orchestrator (ask_orchestrator) what only the user can tell you, and report when the plan is ready.`,
        ``,
        `## The user's request`,
        task.prompt,
        ``,
        `## Notes from the orchestrator`,
        brief,
        ``,
        `Explore the codebase, draft the plan with update_plan, and call report when it is ready for the user's approval.`,
      ].join('\n'),
    });
    return 'The planner is working. Its questions and its report arrive as [steffe] messages: ask the user in chat and relay the answers with message_agent("planner", ...). Tell the user briefly that planning has started, then end your turn.';
  }

  private setPlan(task: Task, spec: string, items: PlanItemInput[]): void {
    const ids = new Set(items.map((i) => i.id));
    if (ids.size !== items.length) throw new Error('item ids must be unique');
    for (const i of items) {
      const missing = i.dependsOn.filter((d) => !ids.has(d));
      if (missing.length) throw new Error(`item ${i.id} depends on unknown items: ${missing.join(', ')}`);
    }
    task.plan = { spec, items: items.map(newItem) };
  }

  /** Extend the plan while executing, e.g. code items after a design-only start was approved. */
  private addItems(task: Task, items: PlanItemInput[]): string {
    if (task.phase !== 'executing' && task.phase !== 'escalated') throw new Error(`task is ${task.phase}; add_items is for executing tasks`);
    if (!task.plan) throw new Error('the task has no plan');
    if (!items.length) throw new Error('no items given');
    const ids = new Set(task.plan.items.map((i) => i.id));
    for (const i of items) {
      if (ids.has(i.id)) throw new Error(`item id ${i.id} is already taken`);
      ids.add(i.id);
    }
    for (const i of items) {
      const missing = i.dependsOn.filter((d) => !ids.has(d));
      if (missing.length) throw new Error(`item ${i.id} depends on unknown items: ${missing.join(', ')}`);
    }
    task.plan.items.push(...items.map(newItem));
    return `Added ${items.map((i) => i.id).join(', ')} to the plan. Dispatch them as usual.`;
  }

  private item(task: Task, id: string): WorkItem {
    const item = task.plan?.items.find((i) => i.id === id);
    if (!item) throw new Error(`no work item "${id}"`);
    return item;
  }

  private async spawnAgent(task: Task, roleName: string, itemId: string | null, brief: string): Promise<string> {
    if (task.phase !== 'executing' && task.phase !== 'escalated') throw new Error(`task is ${task.phase}`);
    if (SINGLETON_ROLES.has(roleName)) throw new Error(`cannot spawn a ${roleName}`);
    const role = await getRole(roleName);
    const item = itemId ? this.item(task, itemId) : undefined;
    if (roleName === 'designer' && item?.kind !== 'design') throw new Error('a designer needs a design item (kind "design")');
    if (item?.kind === 'design' && role.writable === 'cwd' && roleName !== 'designer') {
      throw new Error(`item ${item.id} is a design item; only a designer works on it`);
    }
    if (item?.status === 'blocked' && role.writable === 'cwd') {
      throw new Error(`item ${item.id} is blocked after ${item.attempts} fix rounds; ask_user first`);
    }
    const project = this.project(task);

    let cwd = this.worktree(task);
    if (item && role.writable === 'cwd' && item.mode === 'worktree' && !item.worktreePath) {
      item.branch = `${task.branch}--${item.id}`;
      item.worktreePath = join(WORKTREES_DIR, task.id, 'items', item.id);
      await addWorktree(project.path, item.worktreePath, item.branch, task.branch);
    }
    if (item?.worktreePath && item.status !== 'merged' && item.status !== 'done') cwd = item.worktreePath;

    const agent = await this.startAgent(task, roleName, {
      cwd,
      itemId,
      prompt: `${brief}\n\nWhen you are finished, call mcp__steffe__report (see the steffe-handoff skill).`,
    });
    if (item) {
      const next: Partial<Record<string, WorkItemStatus>> = {
        developer: 'in_progress',
        designer: 'in_progress',
        reviewer: 'in_review',
        tester: 'testing',
      };
      const s = next[roleName];
      if (s && item.status !== 'needs_fix' && item.status !== 'merged' && item.status !== 'done') item.status = s;
    }
    return `Started ${agent.name} in ${cwd}${agent.port != null ? ` (port ${agent.port})` : ''}. Its report will arrive as a [steffe] message; end your turn when you have nothing else to dispatch.`;
  }

  private async messageAgent(task: Task, name: string, text: string): Promise<string> {
    const agent = task.agents.find((a) => a.name === name);
    if (!agent) throw new Error(`no agent named ${name}`);
    if (agent.role === 'orchestrator') throw new Error('cannot message yourself');
    const item = agent.itemId ? task.plan?.items.find((i) => i.id === agent.itemId) : undefined;
    const answering = agent.pendingQuestion;
    if (!answering && item?.status === 'blocked' && agent.role === 'developer') {
      throw new Error(`item ${item.id} is blocked after ${item.attempts} fix rounds; ask_user first`);
    }
    const body = answering
      ? `[from orchestrator] Answer to your question.\n\n${text}\n\nContinue your assignment and call mcp__steffe__report when it is done.`
      : `[from orchestrator]\n\n${text}\n\nWhen you are finished, call mcp__steffe__report again.`;
    agent.pendingQuestion = null;
    agent.busy = true;
    const live = this.live.get(task.id)?.get(name);
    if (live && live.status !== 'ended' && live.status !== 'error') {
      live.send(body);
    } else {
      await this.restartAgent(task, agent, body);
      if (!agent.claudeSessionId) this.live.get(task.id)?.get(name)?.send(body);
    }
    agent.state = 'active';
    return `Sent to ${name}. Its report will arrive as a [steffe] message.`;
  }

  private updateItem(task: Task, by: string, itemId: string, status: WorkItemStatus, note?: string): string {
    const item = this.item(task, itemId);
    if (status === 'done' && item.kind !== 'design' && item.mode === 'worktree' && item.status !== 'merged') {
      throw new Error(`item ${itemId} is a worktree item; merge_item it before marking it done`);
    }
    if (note) item.notes.push({ at: now(), by, text: note });
    if (status === 'needs_fix') {
      item.attempts += 1;
      if (item.attempts >= MAX_FIX_ROUNDS) {
        item.status = 'blocked';
        return `Item ${itemId} has failed validation ${item.attempts} times and is now blocked. Call ask_user: summarise what keeps failing and what you propose.`;
      }
    }
    item.status = status;
    return `Item ${itemId} is now ${status}${status === 'needs_fix' ? ` (fix round ${item.attempts}/${MAX_FIX_ROUNDS - 1})` : ''}.`;
  }

  private async mergeItem(task: Task, itemId: string): Promise<string> {
    const item = this.item(task, itemId);
    const wt = this.worktree(task);
    if (item.kind === 'design') {
      throw new Error(`item ${itemId} is a design: mocks are never merged. Mark it done with update_item once the user approves it.`);
    }
    if (item.status === 'merged' || item.status === 'done') return `Item ${itemId} is already merged.`;
    if (item.mode === 'shared' || !item.branch || !item.worktreePath) {
      const dirty = await statusPorcelain(wt);
      if (dirty) throw new Error(`shared item: the task worktree has uncommitted changes; have the developer commit them:\n${dirty}`);
      item.status = 'merged';
      return `Item ${itemId} works on the task branch directly; nothing to merge. Marked merged.`;
    }
    const dirty = await statusPorcelain(item.worktreePath);
    if (dirty) throw new Error(`the item worktree has uncommitted changes; have the developer commit them first:\n${dirty}`);
    if ((await commitsAhead(wt, task.branch, item.branch)) === 0) {
      throw new Error(`branch ${item.branch} has no commits that aren't on ${task.branch}`);
    }
    const res = await mergeBranch(wt, item.branch, `Merge ${item.id}: ${item.title}`);
    if (!res.ok) {
      return `Merge conflict in: ${res.conflicts.join(', ') || '(see output)'}. The merge was aborted. Ask the developer to merge ${task.branch} into ${item.branch}, resolve the conflicts, commit, and report; then retry merge_item.\n\n${res.output}`;
    }
    item.status = 'merged';
    item.notes.push({ at: now(), by: 'steffe', text: `merged into ${task.branch}` });
    return `Merged ${item.branch} into ${task.branch}. Mark it done with update_item when nothing else is pending for it.`;
  }

  private statusText(task: Task): string {
    const items = (task.plan?.items ?? []).map(
      (i) =>
        `- ${i.id} [${i.status}]${i.kind === 'design' ? ' (design)' : ''} ${i.title}${i.attempts ? ` (fix rounds ${i.attempts})` : ''}${i.dependsOn.length ? ` deps: ${i.dependsOn.join(', ')}` : ''}`,
    );
    const agents = task.agents
      .filter((a) => a.role !== 'orchestrator')
      .map(
        (a) =>
          `- ${a.name} (${a.role}${a.itemId ? `, item ${a.itemId}` : ''}): ${a.state}${a.pendingQuestion ? `, WAITING FOR YOUR ANSWER: ${a.pendingQuestion.slice(0, 300)}` : a.busy ? ', working' : ''}${a.lastReport ? `\n  last report: ${a.lastReport.slice(0, 200)}` : ''}`,
      );
    return [
      `Task "${task.title}" is ${task.phase}. Branch ${task.branch} (base ${task.baseBranch}).`,
      task.question ? `Pending question to user: ${task.question.text}` : '',
      '',
      'Items:',
      ...items,
      '',
      'Agents:',
      ...(agents.length ? agents : ['- none']),
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  private async finish(task: Task, prTitle: string, report: string, draft: boolean): Promise<string> {
    const project = this.project(task);
    const open = (task.plan?.items ?? []).filter((i) => i.status !== 'merged' && i.status !== 'done');
    if (open.length) throw new Error(`items not merged yet: ${open.map((i) => `${i.id} [${i.status}]`).join(', ')}`);
    const busy = task.agents.filter((a) => a.busy && a.role !== 'orchestrator');
    if (busy.length) throw new Error(`agents still working: ${busy.map((a) => a.name).join(', ')}`);
    const items = task.plan?.items ?? [];
    if (items.length && items.every((i) => i.kind === 'design')) return this.finishDesignOnly(task, prTitle, report);
    const wt = this.worktree(task);
    const dirty = await statusPorcelain(wt);
    if (dirty) throw new Error(`the task worktree has uncommitted changes:\n${dirty}`);
    const base = (await tryGit(wt, 'rev-parse', '--verify', `origin/${task.baseBranch}`)).ok
      ? `origin/${task.baseBranch}`
      : task.baseBranch;
    if ((await commitsAhead(wt, base, task.branch)) === 0) {
      throw new Error(`${task.branch} has no commits on top of ${task.baseBranch}`);
    }
    // Only lines this task adds: the marker may legitimately exist in the base (e.g. Steffe's own source).
    const diff = await tryGit(wt, 'diff', '-U0', `${base}...${task.branch}`);
    const mock = diff.out.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++') && (l.includes(MOCK_MARKER) || l.includes(LEGACY_MOCK_MARKER)));
    if (mock.length) {
      throw new Error(
        `mock UI is still on ${task.branch} (${mock.length} added lines marked ${MOCK_MARKER}). Have a developer replace it with the real implementation or remove it, merge, and retry:\n${mock.slice(0, 20).join('\n')}`,
      );
    }

    task.phase = 'finishing';
    task.report = report;
    this.changed(task);
    await mkdir(TASKS_DIR, { recursive: true });
    await writeFile(join(TASKS_DIR, `${task.id}.report.md`), `# ${prTitle}\n\n${report}\n`);

    let result: string;
    const hasRemote = (await tryGit(wt, 'remote', 'get-url', 'origin')).ok;
    if (!hasRemote) {
      result = `The repo has no origin remote, so no PR was opened. The report is saved and ${task.branch} is ready to test locally at ${wt}.`;
    } else {
      const push = await tryGit(wt, 'push', '-u', 'origin', task.branch);
      if (!push.ok) {
        task.phase = 'executing';
        throw new Error(`git push failed:\n${push.out}`);
      }
      try {
        const footer = `\n\n---\n_Opened by Steffe task "${task.title}" · ${task.plan?.items.length ?? 0} work items · $${task.totalCostUsd.toFixed(2)} agent cost_`;
        task.prUrl = await createPullRequest(wt, {
          base: task.baseBranch,
          head: task.branch,
          title: prTitle,
          body: report + footer,
          draft,
        });
      } catch (err) {
        task.phase = 'executing';
        const e = err as { stderr?: string; message: string };
        throw new Error(`gh pr create failed: ${(e.stderr || e.message).trim()}`);
      }
      result = `Pull request opened: ${task.prUrl}`;
    }

    await this.windDown(task, project);
    return `${result}\nThe task is done. Reply with a one-line summary and stop.`;
  }

  /** Subagents and item worktrees go; the task worktree stays for local testing. Branches are kept. */
  private async windDown(task: Task, project: Project): Promise<void> {
    for (const a of task.agents) if (a.role !== 'orchestrator' && a.state !== 'closed') await this.stopAgent(task, a.name);
    for (const item of task.plan?.items ?? []) {
      if (item.worktreePath) {
        await removeWorktree(project.path, item.worktreePath);
        item.worktreePath = null;
      }
    }
    task.phase = 'done';
    this.finishing.add(task.id);
  }

  /** The user only wanted a design: there is no code to merge and no PR; the approved mock stays on its branch. */
  private async finishDesignOnly(task: Task, title: string, report: string): Promise<string> {
    const branches = (task.plan?.items ?? []).map((i) => i.branch).filter(Boolean) as string[];
    task.report = `${report}\n\n---\n_Design only: no pull request. The approved mock is on ${branches.map((b) => `\`${b}\``).join(', ') || '(no branch)'}._`;
    await mkdir(TASKS_DIR, { recursive: true });
    await writeFile(join(TASKS_DIR, `${task.id}.report.md`), `# ${title}\n\n${task.report}\n`);
    await this.windDown(task, this.project(task));
    return `Design-only task finished without a pull request. The approved mock stays on ${branches.join(', ') || '(no branch)'}. Reply with a one-line summary and stop.`;
  }
}
