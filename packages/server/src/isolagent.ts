import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { FlavorListing, Project, SandboxStatus, ServerEvent } from '@steffe/shared';
import { projectWorktrees } from './dataDir.js';
import type { GitRunner } from './git.js';
import { githubToken } from './github.js';
import type { ProjectStore } from './projects.js';
import { PLUGIN_DIR } from './roles.js';

const exec = promisify(execFile);

/**
 * The isolagent CLI. Steffe needs its headless commands (up, exec --no-tty, flavors --json, ...),
 * described in docs/isolagent-integration.md.
 */
const BIN = process.env.STEFFE_ISOLAGENT ?? 'isolagent';
const MAX_BUFFER = 32 * 1024 * 1024;
/** How long a sandbox is taken to be running before `up` (which is idempotent) is asked again. */
const TRUST_MS = 20_000;

/** Steffe's environment at start. Only what a session's env adds to it is forwarded into a sandbox. */
export const HOST_ENV: Readonly<Record<string, string | undefined>> = { ...process.env };

/** What a session needs to run inside its project's sandbox. */
export interface SessionSandbox {
  spawn(opts: SpawnOptions, onStderr: (data: string) => void): SpawnedProcess;
  /** Claude Code's config dir for the sandbox, on this machine: its session history lives there. */
  configDir: string;
}

interface Running {
  name: string;
  stateDir: string;
  checkedAt: number;
}

interface ExecError {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  message: string;
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The project whose checkout or task worktrees cwd is in. */
export function projectAt(projects: ProjectStore, cwd: string): Project | undefined {
  return projects.list().find((p) => isInside(p.path, cwd) || isInside(projectWorktrees(p.id), cwd));
}

function reason(err: unknown): string {
  const e = err as ExecError;
  if (e.code === 'ENOENT') return `${BIN} is not installed (or not on PATH)`;
  return (e.stderr || e.message).trim();
}

/** The Claude Code version the SDK was built for; the sandbox's image should have the same. */
async function sdkClaudeVersion(): Promise<string | null> {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = JSON.parse(await readFile(join(dirname(entry), 'package.json'), 'utf8')) as { claudeCodeVersion?: string };
    return pkg.claudeCodeVersion ?? null;
  } catch {
    return null;
  }
}

export async function listFlavors(dir?: string): Promise<FlavorListing> {
  try {
    const { stdout } = await exec(BIN, ['flavors', '--json', ...(dir ? [dir] : [])], { maxBuffer: MAX_BUFFER });
    const raw = JSON.parse(stdout) as { name: string; agent: string; image_built?: boolean; image_stale?: boolean }[];
    return {
      available: true,
      reason: null,
      flavors: raw.map((f) => ({ name: f.name, agent: f.agent, imageBuilt: !!f.image_built, imageStale: !!f.image_stale })),
    };
  } catch (err) {
    return { available: false, reason: reason(err), flavors: [] };
  }
}

/**
 * One isolagent sandbox (microVM) per project that has a flavor. Sessions, git and the agents'
 * ports of such a project go through it. Paths are the same inside as here: the project and its
 * task folders are shared at their own paths.
 */
export class Sandboxes {
  private readonly status = new Map<string, SandboxStatus>();
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<Running>>();
  /** projectId -> the sandbox's Claude Code config dir here, kept after a stop: history is read from it. */
  private readonly stateDirs = new Map<string, string>();

  constructor(
    private readonly projects: ProjectStore,
    private readonly emit: (event: ServerEvent) => void,
  ) {}

  name(project: Project): string {
    return `steffe-${project.id.slice(0, 8)}`;
  }

  list(): SandboxStatus[] {
    return this.projects.list().filter((p) => p.isolagentFlavor).map((p) => this.statusOf(p));
  }

  private statusOf(project: Project): SandboxStatus {
    return (
      this.status.get(project.id) ?? {
        projectId: project.id,
        name: this.name(project),
        state: 'stopped',
        message: null,
        approval: null,
        warning: null,
      }
    );
  }

  private set(project: Project, patch: Partial<SandboxStatus>): void {
    const next = { ...this.statusOf(project), ...patch };
    this.status.set(project.id, next);
    this.emit({ type: 'sandbox.updated', sandbox: next });
  }

  /** Sandboxes that outlived a Steffe restart are found again. */
  async adopt(): Promise<void> {
    const wanted = this.projects.list().filter((p) => p.isolagentFlavor);
    if (!wanted.length) return;
    try {
      const { stdout } = await exec(BIN, ['ps', '--json'], { maxBuffer: MAX_BUFFER });
      const names = new Set((JSON.parse(stdout) as { name: string }[]).map((e) => e.name));
      for (const p of wanted) if (names.has(this.name(p))) this.set(p, { state: 'running' });
    } catch (err) {
      console.error(`[steffe] isolagent ps: ${reason(err)}`);
    }
  }

  /** The project's sandbox, started if needed. Null for a project without a flavor. */
  async ensure(project: Project): Promise<Running | null> {
    if (!project.isolagentFlavor) return null;
    const known = this.running.get(project.id);
    if (known && Date.now() - known.checkedAt < TRUST_MS) return known;
    let pending = this.starting.get(project.id);
    if (!pending) {
      pending = this.up(project, !known).finally(() => this.starting.delete(project.id));
      this.starting.set(project.id, pending);
    }
    return pending;
  }

  private async up(project: Project, fresh: boolean): Promise<Running> {
    const name = this.name(project);
    const worktrees = projectWorktrees(project.id);
    await mkdir(worktrees, { recursive: true });
    if (fresh) this.set(project, { state: 'starting', message: null, approval: null });
    const args = ['up', '--name', name, '--flavor', project.isolagentFlavor!, '--same-path', '--share', worktrees];
    args.push('--read-only', PLUGIN_DIR, '--idle-timeout', '30m', '--json');
    if (process.env.STEFFE_SANDBOX_MEM) args.push('--mem', process.env.STEFFE_SANDBOX_MEM);
    args.push(project.path);
    try {
      // isolagent reads the account and the git author from its environment, at each start.
      const env = { ...process.env };
      if (project.githubUser) env.GH_TOKEN = await githubToken(project.githubUser);
      if (project.gitEmail) env.GIT_USER_EMAIL = project.gitEmail;
      const { stdout } = await exec(BIN, args, { maxBuffer: MAX_BUFFER, env });
      const info = JSON.parse(stdout) as { state_dir: string };
      const r: Running = { name, stateDir: info.state_dir, checkedAt: Date.now() };
      const restarted = !this.running.has(project.id);
      this.stateDirs.set(project.id, r.stateDir);
      this.running.set(project.id, r);
      if (restarted) this.set(project, { state: 'running', message: null, approval: null, warning: await this.versionWarning(r) });
      return r;
    } catch (err) {
      this.running.delete(project.id);
      const e = err as ExecError;
      let why: { error?: string; file?: string; hash?: string; diff?: string } = {};
      try {
        why = JSON.parse(e.stdout ?? '') as typeof why;
      } catch {
        // a plain failure: its stderr says why
      }
      if (why.error === 'approval_needed') {
        this.set(project, {
          state: 'approval',
          message: null,
          approval: { file: why.file ?? '', hash: why.hash ?? '', diff: why.diff ?? '' },
        });
        throw new Error(`the sandbox needs your approval of ${why.file}: see the project's Sandbox page`);
      }
      if (why.error === 'build_needed') {
        const message = `The image of ${project.isolagentFlavor} is missing or out of date. Build it: isolagent build <its flavor folder>`;
        this.set(project, { state: 'build', message, approval: null });
        throw new Error(message);
      }
      const message = reason(err);
      this.set(project, { state: 'error', message, approval: null });
      throw new Error(`sandbox ${name} did not start: ${message}`);
    }
  }

  private async versionWarning(r: Running): Promise<string | null> {
    const want = await sdkClaudeVersion();
    if (!want) return null;
    try {
      const { stdout } = await exec(BIN, ['exec', '--name', r.name, '--no-tty', '--', 'claude', '--version']);
      const have = stdout.match(/\d+\.\d+\.\d+/)?.[0];
      if (have && have !== want) {
        return `The image has Claude Code ${have}; Steffe's SDK expects ${want}. Pin ${want} in the flavor's Dockerfile if sessions misbehave.`;
      }
    } catch (err) {
      return `Could not run claude in the sandbox: ${reason(err)}`;
    }
    return null;
  }

  /** What a session of this project spawns Claude Code with; null runs it on this machine. */
  async session(project: Project): Promise<SessionSandbox | null> {
    const r = await this.ensure(project);
    if (!r) return null;
    return {
      configDir: r.stateDir,
      spawn: (opts, onStderr) => {
        // The SDK names its own bundled binary (or node and a script); inside it is the image's claude.
        const args = /\.[cm]?js$/.test(opts.args[0] ?? '') ? opts.args.slice(1) : opts.args;
        const env = Object.entries(opts.env).filter(([k, v]) => v !== undefined && HOST_ENV[k] !== v);
        const child = spawn(
          BIN,
          [
            'exec', '--name', r.name, '--no-tty', '--cwd', opts.cwd ?? project.path,
            ...env.flatMap(([k, v]) => ['--env', `${k}=${v}`]),
            '--', 'claude', ...args,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], signal: opts.signal },
        );
        child.stderr.setEncoding('utf8').on('data', onStderr);
        return child;
      },
    };
  }

  /** Where the project's session history is on this machine; null: the usual place. */
  async configDir(project: Project | undefined): Promise<string | null> {
    if (!project?.isolagentFlavor) return null;
    return this.stateDirs.get(project.id) ?? (await this.ensure(project))?.stateDir ?? null;
  }

  /** Run a command in the project's sandbox. */
  async exec(project: Project, cwd: string, file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const r = await this.ensure(project);
    if (!r) throw new Error(`${project.name} has no sandbox`);
    return exec(BIN, ['exec', '--name', r.name, '--no-tty', '--cwd', cwd, '--', file, ...args], { maxBuffer: MAX_BUFFER });
  }

  private projectAt(cwd: string): Project | undefined {
    const project = projectAt(this.projects, cwd);
    return project?.isolagentFlavor ? project : undefined;
  }

  /** For routeGit: git in a sandboxed project's checkouts runs in its sandbox. */
  gitRunner(cwd: string): GitRunner | null {
    const project = this.projectAt(cwd);
    return project ? (args) => this.exec(project, cwd, 'git', args) : null;
  }

  private static range(port: number): string[] {
    return Array.from({ length: 10 }, (_, i) => String(port + i));
  }

  /** Make an agent's ports (port..port+9) reachable on this machine's localhost. */
  async publish(project: Project, port: number): Promise<void> {
    const r = await this.ensure(project);
    if (!r) return;
    try {
      await exec(BIN, ['ports', r.name, ...Sandboxes.range(port).flatMap((p) => ['-p', p])]);
    } catch (err) {
      // Already published (the sandbox outlived a Steffe restart), or taken: the agent still works.
      console.error(`[steffe] publishing ${port}-${port + 9} of ${r.name}: ${reason(err)}`);
    }
  }

  /**
   * Stop what an agent left listening on its ports and unpublish them. In a sandbox the listener
   * on this machine is isolagent itself, so ports.ts' stopListeners must never be used for these.
   */
  async release(project: Project, port: number): Promise<void> {
    const r = this.running.get(project.id);
    if (!r) return; // not running: nothing listens
    const kill =
      'for p in "$@"; do if command -v fuser >/dev/null; then fuser -k -TERM -n tcp "$p"; ' +
      'elif command -v lsof >/dev/null; then lsof -t -iTCP:"$p" -sTCP:LISTEN | xargs -r kill; fi; done; true';
    const ports = Sandboxes.range(port);
    await exec(BIN, ['exec', '--name', r.name, '--no-tty', '--', 'sh', '-c', kill, 'sh', ...ports]).catch(() => {});
    await exec(BIN, ['ports', r.name, ...ports.flatMap((p) => ['--rm', p])]).catch(() => {});
  }

  async stop(project: Project): Promise<void> {
    // A start under way would otherwise finish after this and leave the sandbox up.
    await this.starting.get(project.id)?.catch(() => {});
    this.running.delete(project.id);
    await exec(BIN, ['down', this.name(project)]).catch(() => {}); // not running is fine
    if (project.isolagentFlavor) this.set(project, { state: 'stopped', message: null, approval: null, warning: null });
  }

  /** The user approved the project's .isolagent.toml as shown (by hash); then start. */
  async approve(project: Project, hash: string): Promise<void> {
    try {
      await exec(BIN, ['approve', project.path, '--hash', hash]);
    } catch (err) {
      throw new Error(reason(err));
    }
    await this.ensure(project);
  }

  /** Forget a project's sandbox (its flavor changed, or the project is gone). */
  async forget(project: Project): Promise<void> {
    await this.stop(project);
    this.status.delete(project.id);
    this.stateDirs.delete(project.id);
  }
}
