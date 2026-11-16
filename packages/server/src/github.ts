import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChecksState, PullRequestCheck, PullRequestDetail, PullRequestInfo, PullRequestListing } from '@steffe/shared';

const exec = promisify(execFile);

async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('gh', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

interface RawCheck {
  __typename?: string;
  name?: string; // CheckRun
  context?: string; // StatusContext
  detailsUrl?: string;
  targetUrl?: string;
  status?: string; // CheckRun: QUEUED / IN_PROGRESS / COMPLETED
  conclusion?: string; // CheckRun: SUCCESS / FAILURE / ...
  state?: string; // StatusContext: SUCCESS / FAILURE / PENDING / ERROR
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  state: PullRequestInfo['state'];
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author?: { login?: string };
  statusCheckRollup?: RawCheck[];
  reviewDecision?: string;
  mergeable?: string;
  updatedAt: string;
}

const FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function rollup(checks: RawCheck[] | undefined): ChecksState {
  if (!checks?.length) return 'none';
  let pending = false;
  for (const c of checks) {
    const result = c.conclusion || c.state || '';
    if (FAILING.has(result)) return 'failing';
    if ((c.status && c.status !== 'COMPLETED') || result === 'PENDING' || result === 'EXPECTED') pending = true;
  }
  return pending ? 'pending' : 'passing';
}

function checkState(c: RawCheck): PullRequestCheck['state'] {
  const result = c.conclusion || c.state || '';
  if (FAILING.has(result)) return 'failing';
  if ((c.status && c.status !== 'COMPLETED') || result === 'PENDING' || result === 'EXPECTED') return 'pending';
  if (result === 'SKIPPED' || result === 'NEUTRAL') return 'skipped';
  return 'passing';
}

function toInfo(p: RawPr, taskForBranch: (branch: string) => string | null): PullRequestInfo {
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state,
    isDraft: p.isDraft,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    author: p.author?.login ?? '',
    checks: rollup(p.statusCheckRollup),
    reviewDecision: p.reviewDecision || null,
    mergeable: p.mergeable || null,
    updatedAt: p.updatedAt,
    taskId: taskForBranch(p.headRefName),
  };
}

interface RawPrDetail extends RawPr {
  body: string;
  createdAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files?: { path: string; additions: number; deletions: number }[];
  commits?: { oid: string; messageHeadline: string }[];
  reviews?: { author?: { login?: string }; state: string; submittedAt: string; body: string }[];
  labels?: { name: string }[];
}

export async function getPullRequest(
  cwd: string,
  number: number,
  taskForBranch: (branch: string) => string | null,
): Promise<PullRequestDetail> {
  const fields = `${FIELDS},body,createdAt,additions,deletions,changedFiles,files,commits,reviews,labels`;
  const p = JSON.parse(await gh(cwd, 'pr', 'view', String(number), '--json', fields)) as RawPrDetail;
  return {
    ...toInfo(p, taskForBranch),
    body: p.body ?? '',
    createdAt: p.createdAt,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    files: p.files ?? [],
    commits: (p.commits ?? []).map((c) => ({ oid: c.oid, headline: c.messageHeadline })),
    checkRuns: (p.statusCheckRollup ?? []).map((c) => ({
      name: c.name || c.context || 'check',
      state: checkState(c),
      url: c.detailsUrl || c.targetUrl || null,
    })),
    reviews: (p.reviews ?? []).map((r) => ({ author: r.author?.login ?? '', state: r.state, submittedAt: r.submittedAt, body: r.body })),
    labels: (p.labels ?? []).map((l) => l.name),
  };
}

const FIELDS =
  'number,title,url,state,isDraft,headRefName,baseRefName,author,statusCheckRollup,reviewDecision,mergeable,updatedAt';

/** Open PRs (plus recently closed/merged ones from Steffe task branches) for the repo at `cwd`. */
export async function listPullRequests(
  cwd: string,
  taskForBranch: (branch: string) => string | null,
): Promise<PullRequestListing> {
  let raw: RawPr[];
  try {
    raw = JSON.parse(await gh(cwd, 'pr', 'list', '--state', 'open', '--limit', '50', '--json', FIELDS)) as RawPr[];
    const recent = JSON.parse(
      await gh(cwd, 'pr', 'list', '--state', 'all', '--limit', '30', '--json', FIELDS),
    ) as RawPr[];
    for (const pr of recent) {
      if (taskForBranch(pr.headRefName) && !raw.some((r) => r.number === pr.number)) raw.push(pr);
    }
  } catch (err) {
    const e = err as { stderr?: string; code?: string; message: string };
    const reason = e.code === 'ENOENT' ? 'GitHub CLI (gh) is not installed' : (e.stderr || e.message).trim();
    return { available: false, reason, prs: [] };
  }
  const prs = raw.map((p) => toInfo(p, taskForBranch));
  prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { available: true, reason: null, prs };
}

/** Open a PR for `head` against `base`. Returns the PR url. Reuses an existing open PR for the branch. */
export async function createPullRequest(
  cwd: string,
  opts: { base: string; head: string; title: string; body: string; draft: boolean },
): Promise<string> {
  try {
    const existing = await gh(cwd, 'pr', 'view', opts.head, '--json', 'url,state', '-q', 'select(.state=="OPEN") | .url');
    if (existing) {
      await gh(cwd, 'pr', 'edit', opts.head, '--title', opts.title, '--body', opts.body);
      return existing;
    }
  } catch {
    // no PR for this branch yet
  }
  const args = ['pr', 'create', '--base', opts.base, '--head', opts.head, '--title', opts.title, '--body', opts.body];
  if (opts.draft) args.push('--draft');
  const out = await gh(cwd, ...args);
  return out.split('\n').find((l) => l.startsWith('http')) ?? out;
}

/** Close the open PR whose head is `branch`, if any. Returns its url, or null when there was none. */
export async function closePullRequest(cwd: string, branch: string, comment: string): Promise<string | null> {
  const url = await gh(cwd, 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '-q', '.[0].url');
  if (!url) return null;
  await gh(cwd, 'pr', 'close', url, '--comment', comment);
  return url;
}
