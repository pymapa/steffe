import type { Project, PullRequestListing } from '@steffe/shared';
import { CHECKS, REVIEW, stateBadge } from './prBadges';

interface Props {
  project: Project;
  listing: PullRequestListing | undefined;
  loading: boolean;
  onRefresh: () => void;
  onOpenPr: (number: number) => void;
}

export function PullRequests({ project, listing: data, loading, onRefresh, onOpenPr }: Props) {
  return (
    <div className="prs-view">
      <header className="session-header">
        <div>
          <h2>Pull requests · {project.name}</h2>
          <div className="meta">Open PRs, plus recent ones from Steffe tasks. Refreshes every minute.</div>
        </div>
        <div className="actions">
          <button onClick={onRefresh} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </header>
      <div className="transcript-scroll">
        {!data && <div className="muted">Loading…</div>}
        {data && !data.available && <div className="muted">Pull requests unavailable: {data.reason}</div>}
        {data?.available && data.prs.length === 0 && <div className="muted">No open pull requests.</div>}
        {data?.available && data.prs.length > 0 && (
          <table className="pr-table">
            <tbody>
              {data.prs.map((pr) => {
                const st = stateBadge(pr);
                const ci = CHECKS[pr.checks];
                return (
                  <tr key={pr.number} className="clickable-row" onClick={() => onOpenPr(pr.number)}>
                    <td className="mono muted">#{pr.number}</td>
                    <td className="pr-title">
                      <span className="pr-title-text">{pr.title}</span>
                      <div className="mono muted">{pr.headRefName} → {pr.baseRefName} · {pr.author} · {new Date(pr.updatedAt).toLocaleString()}</div>
                    </td>
                    <td><span className={`pill ${st.cls}`}>{st.label}</span></td>
                    <td>{pr.state === 'OPEN' && <span className={`pill ${ci.cls}`}>{ci.label}</span>}</td>
                    <td>
                      {pr.state === 'OPEN' && pr.reviewDecision && <span className="pill">{REVIEW[pr.reviewDecision] ?? pr.reviewDecision.toLowerCase()}</span>}
                      {pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING' && <span className="pill ci-fail">conflicts</span>}
                    </td>
                    <td>
                      <a href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Open on GitHub">↗</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
