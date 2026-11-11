import { useState } from 'react';
import type { CatalogEntry, CatalogSource, Project } from '@steffe/shared';
import { api } from '../lib/api';

interface Props {
  project: Project;
  kind: CatalogEntry['kind'];
  onCreated: (e: CatalogEntry) => void;
}

export function NewCatalogForm({ project, kind, onCreated }: Props) {
  const [source, setSource] = useState<CatalogSource>('project');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const where =
    source === 'steffe'
      ? kind === 'agent' ? `roles/${slug || '<name>'}.md (Steffe repo)` : `plugin/skills/${slug || '<name>'}/SKILL.md (Steffe repo)`
      : kind === 'agent' ? `${project.path}/.claude/agents/${slug || '<name>'}.md` : `${project.path}/.claude/skills/${slug || '<name>'}/SKILL.md`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createCatalogEntry(project.id, { kind, source, name: slug, description }));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="new-session" onSubmit={submit}>
      <h2>New {kind}</h2>
      <div className="source-choice">
        <label className={`choice ${source === 'project' ? 'active' : ''}`}>
          <input type="radio" checked={source === 'project'} onChange={() => setSource('project')} />
          <span>
            <strong>Project {kind}</strong>
            <span className="muted">
              {kind === 'agent'
                ? `A Claude Code subagent for ${project.name}. Sessions and task agents in this project can use it.`
                : `A Claude Code skill for ${project.name}. Teaches agents project-specific things, like how to run or test the app.`}
            </span>
          </span>
        </label>
        <label className={`choice ${source === 'steffe' ? 'active' : ''}`}>
          <input type="radio" checked={source === 'steffe'} onChange={() => setSource('steffe')} />
          <span>
            <strong>Steffe {kind === 'agent' ? 'role' : 'skill'}</strong>
            <span className="muted">
              {kind === 'agent'
                ? 'A project-agnostic role the orchestrator can spawn in any task, such as a security reviewer.'
                : 'A project-agnostic skill loaded into every task agent in every project.'}
            </span>
          </span>
        </label>
      </div>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'agent' ? 'e.g. security-reviewer' : 'e.g. run-e2e-tests'} autoFocus />
      </label>
      <label>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line: what it does and when to use it" />
      </label>
      <div className="mono muted small-text">Creates {where}</div>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="primary" type="submit" disabled={busy || !slug}>Create and edit</button>
      </div>
    </form>
  );
}
