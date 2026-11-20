import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type GitRunner = (args: string[]) => Promise<{ stdout: string }>;

let route: (cwd: string) => GitRunner | null = () => null;

/**
 * Run git for some directories elsewhere: a sandboxed project's git runs in its sandbox. Agents
 * write those checkouts, and a hook or config they planted would otherwise run on this machine.
 */
export function routeGit(fn: (cwd: string) => GitRunner | null): void {
  route = fn;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const run = route(cwd);
  const { stdout } = run ? await run(args) : await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/** Like git(), but returns the error instead of throwing. */
export async function tryGit(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    return { ok: true, out: await git(cwd, ...args) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: [e.stdout, e.stderr].filter(Boolean).join('\n').trim() || e.message };
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  return (await tryGit(path, 'rev-parse', '--is-inside-work-tree')).ok;
}

/** The branch new work should be based on: origin's default branch, else the current branch. */
export async function defaultBaseBranch(repo: string): Promise<string> {
  const remote = await tryGit(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (remote.ok && remote.out) return remote.out.replace(/^origin\//, '');
  const current = await tryGit(repo, 'symbolic-ref', '--short', 'HEAD');
  if (current.ok && current.out) return current.out;
  throw new Error('could not determine a base branch (detached HEAD and no origin/HEAD)');
}

/** Best start point for a branch off `base`: origin/<base> when it exists (fetched), else local <base>. */
export async function startPoint(repo: string, base: string): Promise<string> {
  if ((await tryGit(repo, 'remote', 'get-url', 'origin')).ok) {
    await tryGit(repo, 'fetch', 'origin', base);
    if ((await tryGit(repo, 'rev-parse', '--verify', `origin/${base}`)).ok) return `origin/${base}`;
  }
  return base;
}

/** Create `branch` from `from` and check it out in a new worktree at `path`. Reuses an existing one. */
export async function addWorktree(repo: string, path: string, branch: string, from: string): Promise<void> {
  const list = await git(repo, 'worktree', 'list', '--porcelain');
  if (list.split('\n').some((l) => l === `worktree ${path}`)) return;
  await mkdir(dirname(path), { recursive: true });
  const exists = (await tryGit(repo, 'rev-parse', '--verify', `refs/heads/${branch}`)).ok;
  if (exists) await git(repo, 'worktree', 'add', path, branch);
  else await git(repo, 'worktree', 'add', '--no-track', '-b', branch, path, from);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await tryGit(repo, 'worktree', 'remove', '--force', path);
  await tryGit(repo, 'worktree', 'prune');
}

export async function statusPorcelain(cwd: string): Promise<string> {
  return git(cwd, 'status', '--porcelain');
}

/** Merge `branch` into the branch checked out at `cwd`. Aborts and reports on conflict. */
export async function mergeBranch(
  cwd: string,
  branch: string,
  message: string,
): Promise<{ ok: true; summary: string } | { ok: false; conflicts: string[]; output: string }> {
  const res = await tryGit(cwd, 'merge', '--no-ff', '-m', message, branch);
  if (res.ok) return { ok: true, summary: res.out };
  const conflicts = (await tryGit(cwd, 'diff', '--name-only', '--diff-filter=U')).out.split('\n').filter(Boolean);
  await tryGit(cwd, 'merge', '--abort');
  return { ok: false, conflicts, output: res.out };
}

export async function commitsAhead(cwd: string, base: string, branch: string): Promise<number> {
  const res = await tryGit(cwd, 'rev-list', '--count', `${base}..${branch}`);
  return res.ok ? Number(res.out) || 0 : 0;
}
