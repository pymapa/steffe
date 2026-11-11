import { useCallback, useEffect, useState } from 'react';
import type { Project, PullRequestDetail, PullRequestInfo } from '@steffe/shared';
import { api } from '../lib/api';
import { Markdown } from './Markdown';
import { CHECKS, REVIEW, stateBadge } from './prBadges';

interface Props {
  project: Project;
  number: number;
  /** Row from the list, shown while the detail loads. */
  summary: PullRequestInfo | undefined;
  onOpenTask: (taskId: string) => void;
}

const CHECK_CLS = { passing: 'ci-pass', failing: 'ci-fail', pending: 'ci-pending', skipped: '' } as const;

export function PullRequestView({ project, number, summary, onOpenTask }: Props) {
  const [pr, setPr] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPr(await api.getPullRequest(project.id, number));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [project.id, number]);

  useEffect(() => {
    setPr(null);
    void load();
  }, [load]);

  const head = pr ?? summary;
  if (!head) {
    return <div className="pad muted">{error ?? 'Loading…'}</div>;
  }
  const st = stateBadge(head);
  const ci = CHECKS[head.checks];

  return (
    <div className="prs-view">
      <header className="session-header">
        <div>
          <h2><span className="muted">#{head.number}</span> {head.title}</h2>
          <div className="meta mono">
            {head.headRefName} → {head.baseRefName} · {head.author}
            {pr && <> · opened {new Date(pr.createdAt).toLocaleString()}</>}
          </div>
        </div>
        <div className="actions">
          <span className={`pill ${st.cls}`}>{st.label}</span>
          {head.state === 'OPEN' && <span className={`pill ${ci.cls}`}>{ci.label}</span>}
          {head.state === 'OPEN' && head.reviewDecision && <span className="pill">{REVIEW[head.reviewDecision] ?? head.reviewDecision.toLowerCase()}</span>}
          {head.state === 'OPEN' && head.mergeable === 'CONFLICTING' && <span className="pill ci-fail">conflicts</span>}
          {head.taskId && <button onClick={() => onOpenTask(head.taskId!)}>Open task</button>}
          <button onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
          <a className="button primary" href={head.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
        </div>
      </header>
      {error && <div className="error banner">{error}</div>}
      <div className="transcript-scroll pr-detail">
        {!pr ? (
          <div className="muted">Loading details…</div>
        ) : (
          <>
            <div className="pr-stats mono">
              <span className="ci-pass-text">+{pr.additions}</span> <span className="ci-fail-text">−{pr.deletions}</span> · {pr.changedFiles} files · {pr.commits.length} commits
              {pr.labels.map((l) => <span key={l} className="pill">{l}</span>)}
            </div>

            <section>
              <h3>Description</h3>
              {pr.body.trim() ? <Markdown>{pr.body}</Markdown> : <div className="muted">No description.</div>}
            </section>

            <section>
              <h3>Checks</h3>
              {pr.checkRuns.length === 0 ? (
                <div className="muted">No checks.</div>
              ) : (
                <ul className="plain-list">
                  {pr.checkRuns.map((c, i) => (
                    <li key={i}>
                      <span className={`pill ${CHECK_CLS[c.state]}`}>{c.state}</span>{' '}
                      {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a> : c.name}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3>Reviews</h3>
              {pr.reviews.length === 0 ? (
                <div className="muted">No reviews yet.</div>
              ) : (
                <ul className="plain-list">
                  {pr.reviews.map((r, i) => (
                    <li key={i}>
                      <span className="mono">{r.author}</span> <span className="pill">{r.state.toLowerCase().replace('_', ' ')}</span>{' '}
                      <span className="muted">{new Date(r.submittedAt).toLocaleString()}</span>
                      {r.body && <Markdown className="review-body">{r.body}</Markdown>}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3>Commits</h3>
              <ul className="plain-list">
                {pr.commits.map((c) => (
                  <li key={c.oid}><span className="mono muted">{c.oid.slice(0, 7)}</span> {c.headline}</li>
                ))}
              </ul>
            </section>

            <section>
              <h3>Files</h3>
              <ul className="plain-list mono">
                {pr.files.map((f) => (
                  <li key={f.path}>
                    <span className="ci-pass-text">+{f.additions}</span> <span className="ci-fail-text">−{f.deletions}</span> {f.path}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
