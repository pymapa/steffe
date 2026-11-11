import type { PullRequestInfo } from '@steffe/shared';

export function stateBadge(pr: PullRequestInfo): { label: string; cls: string } {
  if (pr.state === 'MERGED') return { label: 'MERGED', cls: 'pr-merged' };
  if (pr.state === 'CLOSED') return { label: 'CLOSED', cls: 'pr-closed' };
  if (pr.isDraft) return { label: 'DRAFT', cls: 'pr-draft' };
  return { label: 'OPEN', cls: 'pr-open' };
}

export const CHECKS: Record<PullRequestInfo['checks'], { label: string; short: string; cls: string }> = {
  passing: { label: 'CI passing', short: 'CI ✓', cls: 'ci-pass' },
  failing: { label: 'CI failing', short: 'CI ✗', cls: 'ci-fail' },
  pending: { label: 'CI running', short: 'CI …', cls: 'ci-pending' },
  none: { label: 'no CI', short: '', cls: '' },
};

export const REVIEW: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review required',
};
