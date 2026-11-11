import { useEffect, useState } from 'react';
import { useSteffe } from './lib/useSteffe';
import { usePullRequests } from './lib/usePullRequests';
import { useCatalog } from './lib/useCatalog';
import { CatalogView } from './components/CatalogView';
import { NewCatalogForm } from './components/NewCatalogForm';
import { api } from './lib/api';
import { Sidebar, type Selection } from './components/Sidebar';
import { ProjectTabs } from './components/ProjectTabs';
import { NewChat } from './components/NewChat';
import { SessionView } from './components/SessionView';
import { TaskView } from './components/TaskView';
import { PullRequests } from './components/PullRequests';
import { PullRequestView } from './components/PullRequestView';
import { PrColumn } from './components/PrColumn';
import { DirectoryPicker } from './components/DirectoryPicker';
import { useResizable } from './lib/useResizable';

const ACTIVE_KEY = 'steffe.activeProject';

function readActive(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function App() {
  const { state, ensureTranscript } = useSteffe();
  const [projectId, setProjectId] = useState<string | null>(readActive);
  /** What's open in the middle column, remembered per project tab. */
  const [selections, setSelections] = useState<Record<string, Selection>>({});
  const [opening, setOpening] = useState(false);
  const [browseRoot, setBrowseRoot] = useState('');
  const sidebarW = useResizable({ key: 'sidebar', initial: 260, min: 180, max: 520, unit: 'px', dir: 1 });
  const prColW = useResizable({ key: 'prColumn', initial: 300, min: 200, max: 600, unit: 'px', dir: -1 });

  const project = state.projects.find((p) => p.id === projectId) ?? null;
  const prs = usePullRequests(project?.id ?? null);
  const { catalog, reload: reloadCatalog } = useCatalog(project?.id ?? null);
  const selection: Selection = (project && selections[project.id]) || { kind: 'new-task' };
  const session = selection.kind === 'session' ? state.sessions.find((s) => s.id === selection.id) ?? null : null;
  const task = selection.kind === 'task' ? state.tasks.find((t) => t.id === selection.id) ?? null : null;
  const listing = project ? prs.listings[project.id] : undefined;

  useEffect(() => {
    api.defaults().then((d) => setBrowseRoot(d.browseRoot)).catch(() => {});
  }, []);

  useEffect(() => {
    try {
      if (projectId) localStorage.setItem(ACTIVE_KEY, projectId);
    } catch {
      // storage unavailable; the active tab just isn't remembered
    }
  }, [projectId]);

  useEffect(() => {
    if (session) void ensureTranscript(session.id);
  }, [session?.id, ensureTranscript]);

  // Keep a valid tab selected, and fall back when the open session/task disappears.
  useEffect(() => {
    if (!state.projects.length) return;
    if (!projectId || !state.projects.some((p) => p.id === projectId)) setProjectId(state.projects[0].id);
  }, [state.projects, projectId]);
  useEffect(() => {
    if (!project) return;
    if (selection.kind === 'session' && !state.sessions.some((s) => s.id === selection.id)) select({ kind: 'new-task' });
    if (selection.kind === 'task' && !state.tasks.some((t) => t.id === selection.id)) select({ kind: 'new-task' });
  }, [state.sessions, state.tasks, selection, project]);

  function select(sel: Selection, pid = projectId) {
    if (!pid) return;
    setProjectId(pid);
    setSelections((s) => ({ ...s, [pid]: sel }));
  }

  const openProject = async (path: string) => {
    const p = await api.openProject({ path });
    setOpening(false);
    select({ kind: 'new-task' }, p.id);
  };

  const recentPaths = [...new Set(state.projects.map((p) => p.path))];

  let main: React.ReactNode = null;
  if (!project) {
    main = (
      <div className="empty">
        <p>Open a project to get started.</p>
        <button className="primary" onClick={() => setOpening(true)}>Open project…</button>
      </div>
    );
  } else if (task) {
    main = (
      <TaskView
        key={task.id}
        task={task}
        sessions={state.sessions}
        transcripts={state.transcripts}
        permissions={state.permissions}
        ensureTranscript={(id) => void ensureTranscript(id)}
      />
    );
  } else if (session) {
    main = (
      <SessionView
        session={session}
        transcript={state.transcripts[session.id] ?? []}
        permissions={state.permissions.filter((p) => p.sessionId === session.id)}
      />
    );
  } else if (selection.kind === 'catalog') {
    const list = selection.entryKind === 'agent' ? catalog?.agents : catalog?.skills;
    const entry = list?.find((e) => e.source === selection.source && e.name === selection.name);
    main = entry ? (
      <CatalogView
        key={entry.path}
        project={project}
        entry={entry}
        startEditing={selection.edit}
        onSaved={() => void reloadCatalog()}
      />
    ) : (
      <div className="pad muted">{catalog ? 'Not found.' : 'Loading…'}</div>
    );
  } else if (selection.kind === 'new-catalog') {
    main = (
      <NewCatalogForm
        key={`${project.id}:${selection.entryKind}`}
        project={project}
        kind={selection.entryKind}
        onCreated={async (e) => {
          await reloadCatalog();
          select({ kind: 'catalog', entryKind: e.kind, source: e.source, name: e.name, edit: true });
        }}
      />
    );
  } else if (selection.kind === 'pr') {
    main = (
      <PullRequestView
        key={selection.number}
        project={project}
        number={selection.number}
        summary={listing?.prs.find((p) => p.number === selection.number)}
        onOpenTask={(id) => select({ kind: 'task', id })}
      />
    );
  } else if (selection.kind === 'prs') {
    main = (
      <PullRequests
        project={project}
        listing={listing}
        loading={prs.loading}
        onRefresh={() => void prs.refresh()}
        onOpenPr={(number) => select({ kind: 'pr', number })}
      />
    );
  } else {
    // A session is one task: an orchestrator chat whose first message is the request.
    main = <NewChat key={project.id} project={project} onCreated={(t) => select({ kind: 'task', id: t.id })} />;
  }

  return (
    <div className="app">
      <ProjectTabs
        connected={state.connected}
        projects={state.projects}
        tasks={state.tasks}
        sessions={state.sessions}
        permissions={state.permissions}
        activeId={project?.id ?? null}
        onSelect={(id) => setProjectId(id)}
        onOpenProject={() => setOpening(true)}
        onRemoveProject={(id) => {
          api.removeProject(id).catch((e) => alert(String(e)));
        }}
      />
      <div
        className={`workspace ${project ? '' : 'no-project'}`}
        style={{ '--sidebar-w': sidebarW.css, '--prcol-w': prColW.css } as React.CSSProperties}
      >
        {project && (
          <Sidebar
            project={project}
            sessions={state.sessions}
            tasks={state.tasks}
            permissions={state.permissions}
            catalog={catalog}
            selection={selection}
            onSelect={(sel) => select(sel)}
          />
        )}
        <main className="main">{main}</main>
        {project && (
          <PrColumn
            listing={listing}
            loading={prs.loading}
            onRefresh={() => void prs.refresh()}
            selectedNumber={selection.kind === 'pr' ? selection.number : null}
            onOpenPr={(number) => select({ kind: 'pr', number })}
            onOpenTable={() => select({ kind: 'prs' })}
          />
        )}
        {project && <div className="resize-handle at-sidebar" {...sidebarW.handleProps} />}
        {project && <div className="resize-handle at-prcol" {...prColW.handleProps} />}
      </div>
      {opening && (
        <div className="modal-backdrop" onClick={() => setOpening(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Open project</h2>
            <p className="muted">Pick a repository or folder. Tasks and sessions run in it.</p>
            <DirectoryPicker
              initialPath={project?.path ?? browseRoot}
              recent={recentPaths}
              onSelect={(p) => { void openProject(p); }}
              onCancel={() => setOpening(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
