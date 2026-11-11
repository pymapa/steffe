import { useState } from 'react';
import type { CatalogEntry, PermissionRequest, Project, ProjectCatalog, SessionSummary, Task } from '@steffe/shared';
import { STATUS_LABEL, taskStatus } from '../lib/taskStatus';
import { setupSession } from './SetupView';

export type Selection =
  | { kind: 'new-task' }
  | { kind: 'prs' }
  | { kind: 'pr'; number: number }
  | { kind: 'task'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'setup' }
  | { kind: 'catalog'; entryKind: CatalogEntry['kind']; source: CatalogEntry['source']; name: string; edit?: boolean }
  | { kind: 'new-catalog'; entryKind: CatalogEntry['kind'] };

interface Props {
  project: Project;
  sessions: SessionSummary[];
  tasks: Task[];
  permissions: PermissionRequest[];
  catalog: ProjectCatalog | null;
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
}


const SOURCE_PATH: Record<CatalogEntry['kind'], Record<CatalogEntry['source'], string>> = {
  agent: { project: '.claude/agents', steffe: 'roles/' },
  skill: { project: '.claude/skills', steffe: 'plugin/skills' },
};

const SOURCE_HINT: Record<CatalogEntry['kind'], Record<CatalogEntry['source'], string>> = {
  agent: { project: 'Subagents defined in this project', steffe: 'Steffe task roles, shared by every project' },
  skill: { project: 'Skills defined in this project', steffe: 'Steffe skills, loaded into every task agent' },
};

const COLLAPSE_KEY = 'steffe.sidebarCollapsed';

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Left column: tasks, sessions, agents and skills of the active project. */
export function Sidebar(p: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // not remembered
      }
      return next;
    });
  const isEntry = (e: CatalogEntry) =>
    p.selection?.kind === 'catalog' &&
    p.selection.entryKind === e.kind &&
    p.selection.source === e.source &&
    p.selection.name === e.name;

  const catalogSection = (kind: CatalogEntry['kind'], label: string, entries: CatalogEntry[] | undefined) => (
    <>
      <div className="column-head">
        <h1 className="collapsible" onClick={() => toggle(kind)}>
          <span className="caret">{collapsed[kind] ? '▸' : '▾'}</span> {label} <span className="muted">{entries?.length || ''}</span>
        </h1>
        <button className="small" onClick={() => p.onSelect({ kind: 'new-catalog', entryKind: kind })}>+ New</button>
      </div>
      {!collapsed[kind] && (
        <ul className="session-list">
          {!entries && <li className="muted pr-note">Loading…</li>}
          {(['project', 'steffe'] as const).map((source) => {
            const list = entries?.filter((e) => e.source === source) ?? [];
            if (!entries) return null;
            return (
              <li key={source} className={`catalog-group source-${source}`}>
                <div className="catalog-group-head" title={SOURCE_HINT[kind][source]}>
                  <span className="catalog-group-name">{source === 'project' ? p.project.name : 'Steffe'}</span>
                  <span className="catalog-group-path mono">{SOURCE_PATH[kind][source]}</span>
                  <span className="catalog-group-count">{list.length}</span>
                </div>
                {list.length === 0 && <div className="muted catalog-empty">none</div>}
                {list.map((e) => (
                  <div
                    key={e.path}
                    className={`session-item catalog-item ${isEntry(e) ? 'selected' : ''}`}
                    onClick={() => p.onSelect({ kind: 'catalog', entryKind: e.kind, source: e.source, name: e.name })}
                    title={e.description}
                  >
                    <div className="row"><span className="title">{e.name}</span></div>
                    {e.description && <div className="catalog-desc">{e.description}</div>}
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  // How Steffe's roles use the project's agents and skills (see SetupView).
  const setupEntry = () => {
    const s = setupSession(p.project.id, p.sessions);
    const running = s && (s.status === 'starting' || s.status === 'running');
    const label = p.project.setupProposal
      ? 'Proposal ready'
      : running
        ? 'Analyzing…'
        : p.project.setup
          ? `In use · ${p.project.setup.roles.length} roles`
          : 'Not set up';
    return (
      <ul className="session-list setup-entry">
        <li className={`session-item ${p.selection?.kind === 'setup' ? 'selected' : ''}`} onClick={() => p.onSelect({ kind: 'setup' })}
          title="How Steffe's roles use this project's agents and skills">
          <div className="row">
            <span className={`status ${p.project.setupProposal ? 'task-status-handoff' : running ? 'task-status-working' : ''}`} />
            <span className="title">Project setup</span>
            {p.project.setupProposal && <span className="badge warn">!</span>}
          </div>
          <div className="meta"><span>{label}</span></div>
        </li>
      </ul>
    );
  };

  const is = (sel: Selection) =>
    p.selection?.kind === sel.kind && ('id' in sel ? 'id' in p.selection && p.selection.id === sel.id : true);
  // Each session is exactly one task; plain SDK sessions are not listed.
  const tasks = p.tasks.filter((t) => t.projectId === p.project.id);

  return (
    <aside className="sidebar">
      <div className="column-head">
        <h1>Sessions <span className="muted">{tasks.length || ''}</span></h1>
        <button className="small" onClick={() => p.onSelect({ kind: 'new-task' })}>+ New</button>
      </div>
      <ul className="session-list">
        {tasks.length === 0 && <li className="muted pr-note">No sessions yet.</li>}
        {tasks.map((t) => {
          const st = taskStatus(t, p.sessions, p.permissions);
          const progress = t.plan?.items.length
            ? ` · ${t.plan.items.filter((i) => i.status === 'merged' || i.status === 'done').length}/${t.plan.items.length}`
            : '';
          return (
          <li
            key={t.id}
            className={`session-item ${is({ kind: 'task', id: t.id }) ? 'selected' : ''}`}
            onClick={() => p.onSelect({ kind: 'task', id: t.id })}
          >
            <div className="row">
              <span className={`status task-status-${st.status}`} />
              <span className="title" title={t.prompt}>{t.title}</span>
            </div>
            <div className="meta" title={`${STATUS_LABEL[st.status]}${st.detail ? `: ${st.detail}` : ''} (phase ${t.phase})`}>
              <span className={`status-label task-status-${st.status}`}>{STATUS_LABEL[st.status]}</span>
              <span className="status-detail">{st.detail}{progress}</span>
              <span>${t.totalCostUsd.toFixed(2)}</span>
            </div>
          </li>
          );
        })}
      </ul>
      {setupEntry()}
      {catalogSection('agent', 'Agents', p.catalog?.agents)}
      {catalogSection('skill', 'Skills', p.catalog?.skills)}
    </aside>
  );
}
