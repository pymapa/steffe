import { useEffect, useState } from 'react';
import type { CatalogEntry, CatalogSource, Project } from '@steffe/shared';
import { api } from '../lib/api';
import { Markdown } from './Markdown';
import { useResizable } from '../lib/useResizable';

interface Props {
  project: Project;
  entry: CatalogEntry;
  /** Focus the source editor on open (e.g. right after creating the entry). */
  startEditing?: boolean;
  onSaved: (e: CatalogEntry) => void;
}

type ViewMode = 'source' | 'split' | 'preview';

const NOTES: Record<CatalogEntry['kind'], Record<CatalogSource, string>> = {
  agent: {
    steffe: 'Steffe role (roles/ in the Steffe repo). Applies to agents started after you save.',
    project: 'Claude Code subagent in this project (.claude/agents). Every session and task agent in the project can use it.',
  },
  skill: {
    steffe: 'Steffe skill (plugin/skills in the Steffe repo), loaded into every task agent.',
    project: 'Claude Code skill in this project (.claude/skills), loaded into every session and task agent here.',
  },
};

const MODE_KEY = 'steffe.markdownView';

function readMode(): ViewMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'source' || m === 'split' || m === 'preview') return m;
  } catch {
    // default
  }
  return 'source';
}

/** Splits `---` frontmatter from the body, for the live preview of an unsaved draft. */
function splitFrontmatter(raw: string): { fm: [string, string][]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { fm: [], body: raw };
  const fm: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm.push([kv[1], kv[2].replace(/^["']|["']$/g, '')]);
    else if (fm.length && /^\s+\S/.test(line)) fm[fm.length - 1][1] += ` ${line.trim()}`;
  }
  return { fm, body: raw.slice(m[0].length) };
}

export function CatalogView({ project, entry, startEditing, onSaved }: Props) {
  const splitW = useResizable({ key: 'markdownSplit', initial: 50, min: 20, max: 80, unit: '%', dir: 1 });
  const [mode, setModeState] = useState<ViewMode>(() => (startEditing ? 'source' : readMode()));
  const [draft, setDraft] = useState(entry.raw);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== entry.raw;

  useEffect(() => {
    setDraft(entry.raw);
    setError(null);
  }, [entry.path, entry.raw]);

  const setMode = (m: ViewMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // not remembered
    }
  };

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.saveCatalogEntry(project.id, { kind: entry.kind, source: entry.source, name: entry.name, raw: draft }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const { fm, body } = splitFrontmatter(draft);
  const shownFm = fm.filter(([k]) => k !== 'name' && k !== 'description');

  const source = (
    <textarea
      className="md-source mono"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
      }}
      spellCheck={false}
      autoFocus={startEditing}
    />
  );

  const preview = (
    <div className="md-preview">
      {shownFm.length > 0 && (
        <table className="fm-table">
          <tbody>
            {shownFm.map(([k, v]) => (
              <tr key={k}><td className="mono muted">{k}</td><td className="mono">{v || <span className="muted">—</span>}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {body.trim() ? <Markdown>{body}</Markdown> : <div className="muted">Empty.</div>}
    </div>
  );

  return (
    <div className="prs-view">
      <header className={`session-header catalog-header-${entry.source}`}>
        <div>
          <h2>{entry.name}{dirty && <span className="muted" title="Unsaved changes"> ●</span>}</h2>
          <div className="meta">{entry.description}</div>
          <div className="meta mono">{entry.path}</div>
        </div>
        <div className="actions">
          <span className="pill">{entry.kind}</span>
          <span className={`pill source-${entry.source}`}>{entry.source === 'project' ? `project · ${project.name}` : 'steffe · shared'}</span>
          <div className="segmented" role="group" aria-label="View">
            {(['source', 'split', 'preview'] as const).map((m) => (
              <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}
                title={m === 'split' ? 'Source with the rendered preview next to it' : undefined}>
                {m === 'source' ? 'Source' : m === 'split' ? 'Split' : 'Preview'}
              </button>
            ))}
          </div>
          {dirty && <button onClick={() => { setDraft(entry.raw); setError(null); }} disabled={busy}>Revert</button>}
          <button className="primary" onClick={() => void save()} disabled={busy || !dirty} title="⌘S">Save</button>
        </div>
      </header>
      {error && <div className="error banner">{error}</div>}
      <div className="md-note muted small-text">{NOTES[entry.kind][entry.source]}</div>
      <div className={`md-panes md-${mode}`} style={{ '--md-source': splitW.value } as React.CSSProperties}>
        {mode === 'split' && <div className="resize-handle at-md" {...splitW.handleProps} />}
        {mode !== 'preview' && source}
        {mode !== 'source' && preview}
      </div>
    </div>
  );
}
