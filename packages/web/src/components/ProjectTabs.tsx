import type { PermissionRequest, Project, SessionSummary, Task } from '@steffe/shared';

interface Props {
  connected: boolean;
  projects: Project[];
  tasks: Task[];
  sessions: SessionSummary[];
  permissions: PermissionRequest[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onOpenProject: () => void;
  onRemoveProject: (id: string) => void;
}

/** Top bar: one tab per opened project. */
export function ProjectTabs(p: Props) {
  const needsYou = (projectId: string) => {
    const sessionIds = new Set(p.sessions.filter((s) => s.projectId === projectId).map((s) => s.id));
    return (
      p.tasks.some((t) => t.projectId === projectId && t.question) ||
      p.permissions.some((x) => sessionIds.has(x.sessionId))
    );
  };
  const running = (projectId: string) =>
    p.tasks.some((t) => t.projectId === projectId && (t.phase === 'executing' || t.phase === 'finishing'));

  return (
    <header className="topbar">
      <div className="brand">
        <h1>Steffe</h1>
        <span className={`dot ${p.connected ? 'ok' : 'bad'}`} title={p.connected ? 'connected' : 'disconnected'} />
      </div>
      <nav className="project-tabs">
        {p.projects.map((project) => (
          <div
            key={project.id}
            className={`project-tab ${project.id === p.activeId ? 'active' : ''}`}
            onClick={() => p.onSelect(project.id)}
            title={project.path}
          >
            {running(project.id) && <span className="status status-running" />}
            <span className="project-tab-name">{project.name}</span>
            {needsYou(project.id) && <span className="badge warn">?</span>}
            <button
              className="link remove"
              title="Remove project from Steffe (does not delete files)"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Remove ${project.name} from Steffe?`)) p.onRemoveProject(project.id);
              }}
            >×</button>
          </div>
        ))}
        <button className="project-tab-add" onClick={p.onOpenProject} title="Open project">+</button>
      </nav>
    </header>
  );
}
