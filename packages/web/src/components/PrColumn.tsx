import type { PullRequestListing } from '@steffe/shared';
import { CHECKS, stateBadge } from './prBadges';

interface Props {
  listing: PullRequestListing | undefined;
  loading: boolean;
  onRefresh: () => void;
  selectedNumber: number | null;
  onOpenPr: (number: number) => void;
  onOpenTable: () => void;
}

/** Right column: pull requests of the active project, always visible. */
export function PrColumn({ listing, loading, onRefresh, selectedNumber, onOpenPr, onOpenTable }: Props) {
  const openCount = listing?.prs.filter((p) => p.state === 'OPEN').length ?? 0;

  return (
    <aside className="pr-column">
      <div className="column-head">
        <h1>
          <button className="link" onClick={onOpenTable} title="Open the full table">Pull requests</button>{' '}
          <span className="muted">{listing?.available ? openCount : ''}</span>
        </h1>
        <button className="small" onClick={onRefresh} disabled={loading} title="Refresh (auto every minute)">
          {loading ? '…' : '↻'}
        </button>
      </div>
      <div className="pr-column-list">
        {!listing && <div className="muted pr-note">Loading…</div>}
        {listing && !listing.available && <div className="muted pr-note-wrap">Unavailable: {listing.reason}</div>}
        {listing?.available && listing.prs.length === 0 && <div className="muted pr-note">No open PRs.</div>}
        {listing?.prs.map((pr) => {
          const st = stateBadge(pr);
          const ci = CHECKS[pr.checks];
          return (
            <div key={pr.number} className={`pr-card ${pr.number === selectedNumber ? 'selected' : ''}`} onClick={() => onOpenPr(pr.number)}
              title={`${pr.headRefName} → ${pr.baseRefName}`}>
              <div className="pr-card-title">
                <span className="mono muted">#{pr.number}</span> {pr.title}
              </div>
              <div className="pr-badges">
                <span className={`pill ${st.cls}`}>{st.label}</span>
                {pr.state === 'OPEN' && ci.short && <span className={`pill ${ci.cls}`}>{ci.short}</span>}
                {pr.state === 'OPEN' && pr.reviewDecision === 'APPROVED' && <span className="pill ci-pass">approved</span>}
                {pr.state === 'OPEN' && pr.reviewDecision === 'CHANGES_REQUESTED' && <span className="pill ci-fail">changes</span>}
                {pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING' && <span className="pill ci-fail">conflicts</span>}
                {pr.taskId && <span className="pill">task</span>}
                <a className="pr-ext" href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>↗</a>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
