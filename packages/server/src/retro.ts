import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Project,
  RetroAgentMetrics,
  RetroMetrics,
  RetroRecord,
  Task,
  TaskAgent,
  TranscriptEntry,
} from '@steffe/shared';
import { retroServer, type RetroInput } from './agentTools.js';
import { writeFileAtomic } from './atomicWrite.js';
import { DATA_DIR, projectWorktrees } from './dataDir.js';
import { isInside, type Sandboxes } from './isolagent.js';
import type { ProjectStore } from './projects.js';
import { FACILITATOR_ROLE, PLUGIN_DIR, getRole } from './roles.js';
import { readHistory, readTimedHistory, type ManagedSession } from './session.js';
import type { SessionManager } from './sessionManager.js';
import { taskDir, type TaskManager } from './tasks.js';

/** One JSON file per retro (RetroRecord). They outlive their task: they are there to be analysed across tasks. */
const RETROS_DIR = join(DATA_DIR, 'retros');

const SLOWEST = 12;
/** Tool calls shorter than this aren't worth listing as slow. */
const SLOW_SECONDS = 20;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s);
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
/** UTC, to the second: MM-DD HH:MM:SS. */
const stamp = (iso: string) => iso.slice(5, 19).replace('T', ' ');

interface AgentTimeline {
  agent: TaskAgent;
  /** The transcript as text, one event per line; null when the agent never started. */
  text: string | null;
  metrics: RetroAgentMetrics;
  slow: RetroMetrics['slowest'];
}

function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const main = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.prompt ?? i.description;
  return clip((typeof main === 'string' ? main : JSON.stringify(input ?? {})).replace(/\s+/g, ' '), 160);
}

/** An agent's transcript as a timeline the facilitator can read and grep, and what can be counted from it. */
function timeline(agent: TaskAgent, entries: TranscriptEntry[], timed: boolean): AgentTimeline {
  const lines: string[] = [];
  const calls = new Map<string, { name: string; summary: string; at: number }>();
  const slow: RetroMetrics['slowest'] = [];
  let toolCalls = 0;
  let toolErrors = 0;
  for (const e of entries) {
    const at = timed ? `[${stamp(e.timestamp)}] ` : '';
    for (const b of e.blocks) {
      if (b.type === 'text') {
        lines.push(`${at}${e.role.toUpperCase()}: ${clip(b.text.trim(), 2000)}`);
      } else if (b.type === 'tool_use') {
        toolCalls++;
        calls.set(b.id, { name: b.name, summary: toolSummary(b.name, b.input), at: Date.parse(e.timestamp) });
        lines.push(`${at}CALL ${b.name}: ${clip(JSON.stringify(b.input ?? {}), 600)}`);
      } else if (b.type === 'tool_result') {
        const call = calls.get(b.toolUseId);
        const seconds = call && timed ? Math.round((Date.parse(e.timestamp) - call.at) / 1000) : null;
        if (b.isError) toolErrors++;
        if (call && seconds != null && seconds >= SLOW_SECONDS) slow.push({ agent: agent.name, tool: call.name, summary: call.summary, seconds });
        const tags = [seconds != null ? `${seconds}s` : '', b.isError ? 'ERROR' : ''].filter(Boolean).join(', ');
        lines.push(`${at}RESULT ${call?.name ?? '?'}${tags ? ` (${tags})` : ''}: ${clip(b.content.trim(), b.isError ? 1500 : 400)}`);
      }
    }
  }
  const first = timed && entries[0] ? Date.parse(entries[0].timestamp) - Date.parse(agent.spawnedAt) : null;
  return {
    agent,
    text: entries.length ? lines.join('\n') : null,
    slow,
    metrics: {
      name: agent.name,
      role: agent.role,
      itemId: agent.itemId,
      activeMs: agent.activeMs,
      costUsd: agent.costUsd,
      waitMs: first != null && first > 0 ? first : null,
      toolCalls,
      toolErrors,
      outcome: /^(success|failure|blocked):/.exec(agent.lastReport ?? '')?.[1] ?? null,
    },
  };
}

interface Running {
  session: ManagedSession;
  record: Omit<RetroRecord, 'analysis' | 'facilitator'>;
  startedAt: string;
  dir: string;
  analysis: RetroRecord['analysis'] | null;
  nudged: boolean;
}

/**
 * Runs a task's retro: when a round finishes (the orchestrator called finish and every agent has
 * stopped), a facilitator agent reads the team's transcripts and Steffe's numbers and records what
 * took long, what failed and what was redone (save_retro). The facilitator is not part of the
 * team: it runs after it, outside the agent limit, and is never spawned by an orchestrator.
 */
export class RetroManager {
  /** taskId -> the retro in progress */
  private readonly live = new Map<string, Running>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly projects: ProjectStore,
    private readonly sandboxes: Sandboxes,
    private readonly tasks: TaskManager,
  ) {}

  /** Start a retro of the task as it is now. */
  async run(taskId: string): Promise<Task> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('task not found');
    if (this.live.has(taskId)) throw new Error('a retro of this task is already running');
    if (!['review', 'done', 'cancelled', 'failed'].includes(task.phase)) {
      throw new Error(`the task is ${task.phase}: a retro looks back at a round that has ended`);
    }
    const project = this.projects.get(task.projectId);
    if (!project) throw new Error('project not found');
    const startedAt = new Date().toISOString();
    this.tasks.setRetro(taskId, { state: 'running', startedAt, recordId: null, error: null });
    try {
      await this.start(task, project, startedAt);
    } catch (err) {
      this.tasks.setRetro(taskId, { state: 'failed', startedAt, recordId: null, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return task;
  }

  /** The task is going away: drop its running retro. Stored records stay. */
  stop(taskId: string): void {
    const r = this.live.get(taskId);
    this.live.delete(taskId);
    if (r) this.sessions.remove(r.session.id);
  }

  async list(projectId?: string): Promise<RetroRecord[]> {
    const records: RetroRecord[] = [];
    for (const f of (await readdir(RETROS_DIR).catch(() => [] as string[])).sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(await readFile(join(RETROS_DIR, f), 'utf8')) as RetroRecord;
        if (!projectId || r.projectId === projectId) records.push(r);
      } catch (err) {
        console.error(`[steffe] could not read retro ${f}:`, err);
      }
    }
    return records;
  }

  /** The task's latest stored retro. */
  async forTask(taskId: string): Promise<RetroRecord | null> {
    const id = this.tasks.get(taskId)?.retro?.recordId;
    if (!id || !/^[\w-]+$/.test(id)) return null;
    return readFile(join(RETROS_DIR, `${id}.json`), 'utf8').then((raw) => JSON.parse(raw) as RetroRecord, () => null);
  }

  private async start(task: Task, project: Project, startedAt: string): Promise<void> {
    const role = await getRole(FACILITATOR_ROLE);
    const sandbox = await this.sandboxes.session(project);
    // Under the task's folder: a sandboxed project shares that into its sandbox.
    const dir = join(taskDir(task), 'retro');
    if (sandbox && !isInside(projectWorktrees(project.id), dir)) {
      throw new Error(`this task is from before ${project.name} got a sandbox, and its folder isn't shared into it`);
    }
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'agents'), { recursive: true });

    const configDir = await this.sandboxes.configDir(project);
    const timelines: AgentTimeline[] = [];
    for (const agent of task.agents) {
      let entries: TranscriptEntry[] = [];
      let timed = true;
      if (agent.claudeSessionId) {
        const stored = await readTimedHistory(agent.claudeSessionId, configDir);
        timed = stored != null;
        entries = stored ?? (await readHistory(agent.claudeSessionId, agent.cwd, configDir).catch(() => []));
      }
      const t = timeline(agent, entries, timed);
      if (t.text != null) await writeFile(join(dir, 'agents', `${agent.name}.md`), `${t.text}\n`);
      timelines.push(t);
    }

    const earlier = (await this.list()).filter((r) => r.taskId === task.id);
    const items = task.plan?.items ?? [];
    const agents = timelines.map((t) => t.metrics);
    const metrics: RetroMetrics = {
      wallMs: Date.parse(startedAt) - Date.parse(task.createdAt),
      activeMs: agents.reduce((n, a) => n + a.activeMs, 0),
      costUsd: task.totalCostUsd,
      fixRounds: items.reduce((n, i) => n + i.attempts, 0),
      toolCalls: agents.reduce((n, a) => n + a.toolCalls, 0),
      toolErrors: agents.reduce((n, a) => n + a.toolErrors, 0),
      agents,
      items: items.map((i) => ({ id: i.id, title: i.title, kind: i.kind, status: i.status, fixRounds: i.attempts })),
      slowest: timelines.flatMap((t) => t.slow).sort((a, b) => b.seconds - a.seconds).slice(0, SLOWEST),
    };
    const record: Running['record'] = {
      // Sorts by time; the task id keeps two tasks finishing in the same second apart.
      id: `${startedAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${task.id.slice(0, 8)}`,
      taskId: task.id,
      projectId: project.id,
      projectName: project.name,
      taskTitle: task.title,
      round: earlier.length + 1,
      createdAt: startedAt,
      metrics,
    };

    const session = this.sessions.create(
      {
        projectId: project.id,
        prompt: this.brief(task, project, record, timelines, dir, earlier.at(-1)),
        model: process.env.STEFFE_FORCE_MODEL || role.model,
        permissionMode: 'default',
        title: `retro · ${task.title}`,
      },
      dir,
      {
        taskId: task.id,
        role: FACILITATOR_ROLE,
        systemPromptAppend: role.prompt,
        mcpServers: { steffe: retroServer({ saveRetro: (a) => this.save(task.id, a) }) },
        disallowedTools: role.disallowedTools,
        plugins: [PLUGIN_DIR],
        writableRoots: [],
        onTurnEnd: (s) => void this.onTurnEnd(task.id, s),
        onExit: (s) => this.onExit(task.id, s),
      },
      sandbox,
    );
    this.live.set(task.id, { session, record, startedAt, dir, analysis: null, nudged: false });
  }

  private brief(
    task: Task,
    project: Project,
    record: Running['record'],
    timelines: AgentTimeline[],
    dir: string,
    previous: RetroRecord | undefined,
  ): string {
    const m = record.metrics;
    const items = task.plan?.items ?? [];
    return [
      `[steffe] Run the retro of this task round and store it with save_retro.`,
      ``,
      `# Task: ${task.title}`,
      `- Project: ${project.name}`,
      `- Phase: ${task.phase}${task.prUrl ? ` · PR ${task.prUrl}` : ''}`,
      `- Created ${task.createdAt}, retro at ${record.createdAt} (UTC): ${minutes(m.wallMs)} wall time, ${minutes(m.activeMs)} of agent work, $${m.costUsd.toFixed(2)}`,
      `- ${m.fixRounds} fix round(s), ${m.toolCalls} tool calls of which ${m.toolErrors} returned an error`,
      ...(previous
        ? [
            `- Round ${record.round}: the task was reopened after an earlier retro (${previous.createdAt}). Cover what happened since then, and why the round before didn't settle it. That retro said: ${clip(previous.analysis.summary, 1200)}`,
          ]
        : []),
      ``,
      `## The user's request`,
      clip(task.prompt || '(an image)', 3000),
      ``,
      `## Spec`,
      clip(task.plan?.spec ?? '(no plan)', 3000),
      ``,
      `## Work items`,
      ...(items.length ? [] : ['- none']),
      ...items.flatMap((i) => [
        `- \`${i.id}\` [${i.status}] ${i.title}${i.kind === 'design' ? ' (design)' : ''} · fix rounds ${i.attempts} · validators: ${i.validators.join(', ') || 'none'}`,
        ...i.notes.map((n) => `  - ${stamp(n.at)} ${n.by}: ${clip(n.text.replace(/\s+/g, ' '), 300)}`),
      ]),
      ``,
      `## Agents`,
      ...timelines.map(({ agent: a, metrics: am, text }) =>
        [
          `- **${a.name}** (${a.role}${a.itemId ? `, item ${a.itemId}` : ''}): ${minutes(a.activeMs)} active, $${a.costUsd.toFixed(2)}`,
          am.waitMs != null && am.waitMs > 60_000 ? `, waited ${minutes(am.waitMs)} before starting` : '',
          `, ${am.toolCalls} tool calls (${am.toolErrors} errors)`,
          a.busy && a.state !== 'closed' ? ', was still working when the round ended' : '',
          text == null ? ', no transcript (it never started)' : `; transcript: ${join(dir, 'agents', `${a.name}.md`)}`,
          a.lastReport ? `\n  - last report: ${clip(a.lastReport.replace(/\s+/g, ' '), 300)}` : '',
        ].join(''),
      ),
      ``,
      `## Slowest tool calls`,
      ...(m.slowest.length ? m.slowest.map((s) => `- ${s.seconds}s · ${s.agent} · ${s.tool}: ${s.summary}`) : [`- none over ${SLOW_SECONDS}s`]),
      ``,
      `## The orchestrator's final report`,
      clip(task.report ?? '(none)', 4000),
      ``,
      `Transcript lines are \`[MM-DD HH:MM:SS] USER|ASSISTANT|CALL <tool>|RESULT <tool> (<seconds>, ERROR)\`, in UTC, with long texts clipped. They are big: grep them (ERROR, the slow commands above, "needs_fix", "[steffe]") and read around the hits rather than reading them whole.`,
    ].join('\n');
  }

  private async save(taskId: string, input: RetroInput): Promise<string> {
    const r = this.live.get(taskId);
    if (!r) throw new Error('this retro is no longer running');
    r.analysis = {
      summary: input.summary,
      rating: input.rating,
      wentWell: input.went_well,
      findings: input.findings.map((f) => ({
        kind: f.kind,
        title: f.title,
        detail: f.detail,
        agent: f.agent ?? null,
        itemId: f.itemId ?? null,
        minutes: f.minutes ?? null,
        suggestion: f.suggestion ?? null,
      })),
    };
    return 'Retro stored. End your turn now with a one-line summary.';
  }

  /** Its turn is over: the retro is stored with what the facilitator itself cost (known only now). */
  private async onTurnEnd(taskId: string, s: ManagedSession): Promise<void> {
    const r = this.live.get(taskId);
    if (!r || r.session !== s) return;
    if (!r.analysis) {
      if (r.nudged) return this.fail(taskId, `the facilitator ended without saving a retro. Its last message:\n\n${s.lastAssistantText}`);
      r.nudged = true;
      s.send('[steffe] You ended your turn without calling mcp__steffe__save_retro, so nothing is stored. Call it now with your analysis.');
      return;
    }
    this.live.delete(taskId);
    const record: RetroRecord = {
      ...r.record,
      analysis: r.analysis,
      facilitator: { model: s.model, costUsd: s.totalCostUsd, activeMs: s.activeMs() },
    };
    try {
      await mkdir(RETROS_DIR, { recursive: true });
      await writeFileAtomic(join(RETROS_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
      this.tasks.setRetro(taskId, { state: 'done', startedAt: r.startedAt, recordId: record.id, error: null });
      // The transcripts were only copies for the facilitator.
      await rm(r.dir, { recursive: true, force: true });
    } catch (err) {
      this.tasks.setRetro(taskId, { state: 'failed', startedAt: r.startedAt, recordId: null, error: `could not store the retro: ${String(err)}` });
    }
    this.sessions.remove(s.id);
  }

  private onExit(taskId: string, s: ManagedSession): void {
    const r = this.live.get(taskId);
    if (!r || r.session !== s) return; // stored, or stopped on purpose
    this.fail(taskId, s.status === 'error' ? `the facilitator crashed: ${s.lastError ?? 'unknown error'}` : 'the facilitator stopped before saving a retro');
  }

  private fail(taskId: string, error: string): void {
    const r = this.live.get(taskId);
    if (!r) return;
    this.live.delete(taskId);
    this.tasks.setRetro(taskId, { state: 'failed', startedAt: r.startedAt, recordId: null, error });
    this.sessions.remove(r.session.id);
  }
}
