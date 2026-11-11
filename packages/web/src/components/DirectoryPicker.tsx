import { useEffect, useState } from 'react';
import type { DirectoryListing } from '@steffe/shared';
import { api } from '../lib/api';

interface Props {
  initialPath: string;
  /** Recently used project folders to offer as shortcuts. */
  recent: string[];
  onSelect: (path: string) => void;
  onCancel: () => void;
}

export function DirectoryPicker({ initialPath, recent, onSelect, onCancel }: Props) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState(initialPath);
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listDirs(path, hidden)
      .then((l) => { if (!cancelled) { setListing(l); setFilter(''); } })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [path, hidden]);

  const crumbs = listing ? breadcrumbs(listing.path) : [];
  const dirs = listing?.dirs.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase())) ?? [];

  return (
    <div className="dir-picker">
      <div className="dir-crumbs">
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <span className="muted">/</span>}
            <button type="button" className="link" onClick={() => setPath(c.path)}>{c.name}</button>
          </span>
        ))}
      </div>
      <div className="dir-toolbar">
        <input
          autoFocus
          placeholder="Filter folders…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirs.length === 1) { e.preventDefault(); setPath(dirs[0].path); }
            if (e.key === 'Escape') onCancel();
          }}
        />
        <label className="inline">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <ul className="dir-list">
        {listing?.parent && (
          <li><button type="button" className="link" onClick={() => setPath(listing.parent!)}>..</button></li>
        )}
        {dirs.map((d) => (
          <li key={d.path}>
            <button type="button" className="link" onClick={() => setPath(d.path)}>
              {d.name}{d.isGitRepo && <span className="badge git">git</span>}
            </button>
            {d.isGitRepo && (
              <button type="button" className="small" onClick={() => onSelect(d.path)}>use</button>
            )}
          </li>
        ))}
        {listing && dirs.length === 0 && <li className="muted">No subfolders</li>}
      </ul>
      {recent.length > 0 && (
        <div className="dir-recent">
          <div className="muted">Recent</div>
          {recent.map((r) => (
            <button key={r} type="button" className="link mono" onClick={() => onSelect(r)}>{r}</button>
          ))}
        </div>
      )}
      <div className="actions">
        <span className="mono muted grow">{listing?.path ?? path}</span>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={!listing} onClick={() => listing && onSelect(listing.path)}>
          Use this folder
        </button>
      </div>
    </div>
  );
}

function breadcrumbs(p: string): { name: string; path: string }[] {
  const parts = p.split('/').filter(Boolean);
  const out = [{ name: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += '/' + part;
    out.push({ name: part, path: acc });
  }
  return out;
}
