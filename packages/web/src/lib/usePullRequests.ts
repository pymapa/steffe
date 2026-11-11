import { useCallback, useEffect, useRef, useState } from 'react';
import type { PullRequestListing } from '@steffe/shared';
import { api } from './api';

const REFRESH_MS = 60_000;

/**
 * PR listing of the active project, refreshed every minute. Listings of other
 * projects stay cached so switching tabs shows them instantly while they refresh.
 */
export function usePullRequests(projectId: string | null) {
  const [listings, setListings] = useState<Record<string, PullRequestListing>>({});
  const [loading, setLoading] = useState(false);
  const active = useRef(projectId);
  active.current = projectId;

  const refresh = useCallback(async () => {
    const id = active.current;
    if (!id) return;
    setLoading(true);
    let listing: PullRequestListing;
    try {
      listing = await api.listPullRequests(id);
    } catch (e) {
      listing = { available: false, reason: String(e), prs: [] };
    }
    setListings((l) => ({ ...l, [id]: listing }));
    if (active.current === id) setLoading(false);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [projectId, refresh]);

  return { listings, loading, refresh };
}
