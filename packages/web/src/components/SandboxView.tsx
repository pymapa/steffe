import { useEffect, useState } from 'react';
import type { FlavorListing, Project, SandboxStatus } from '@steffe/shared';
import { api } from '../lib/api';

interface Props {
  project: Project;
  sandbox: SandboxStatus | null;
  /** The user made the project's first choice (a flavor or none): its setup agent starts now. */
  onFirstChoice: () => void;
}

const STATE_CLASS: Partial<Record<SandboxStatus['state'], string>> = {
  running: 'task-status-working',
  starting: 'task-status-working',
  approval: 'task-status-handoff',
  build: 'task-status-handoff',
};

/** Which isolagent flavor (microVM image) the project's sessions run in, and that sandbox's state. */
export function SandboxView({ project, sandbox, onFirstChoice }: Props) {
  const [listing, setListing] = useState<FlavorListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [email, setEmail] = useState(project.gitEmail ?? '');
  const githubUser = project.githubUser ?? '';
  const flavor = project.isolagentFlavor ?? '';
  const unchosen = project.isolagentFlavor === undefined;
  const choose = async (value: string | null) => {
    await api.setFlavor(project.id, value);
    if (unchosen) onFirstChoice();
  };

  useEffect(() => {
    api.listFlavors(project.id).then(setListing, (e) => setError(String(e)));
  }, [project.id]);

  useEffect(() => {
    api.listGithubAccounts().then((r) => setAccounts(r.accounts), () => setAccounts([]));
  }, []);

  useEffect(() => setEmail(project.gitEmail ?? ''), [project.id, project.gitEmail]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const known = listing?.flavors.some((f) => f.name === flavor);

  return (
    <div className="task-view">
      <header className="session-header">
        <div>
          <h2>Sandbox</h2>
          <div className="meta">Run {project.name}’s sessions in an isolagent microVM instead of on this machine.</div>
        </div>
        <div className="actions">
          {sandbox && <span className={`pill ${STATE_CLASS[sandbox.state] ?? ''}`}>{sandbox.state}</span>}
          {sandbox && sandbox.state !== 'running' && sandbox.state !== 'starting' && (
            <button disabled={busy} onClick={() => act(() => api.startSandbox(project.id))}>Start</button>
          )}
          {sandbox && (sandbox.state === 'running' || sandbox.state === 'starting') && (
            <button disabled={busy} onClick={() => act(() => api.stopSandbox(project.id))}>Stop</button>
          )}
        </div>
      </header>
      {error && <div className="error banner">{error}</div>}
      <div className="task-body single">
        <section className="task-left">
          <div className="pad sandbox-view">
            <label className="sandbox-flavor">
              <span>Flavor</span>
              <select value={unchosen ? 'unchosen' : flavor} disabled={busy || !listing}
                onChange={(e) => act(() => choose(e.target.value || null))}>
                {unchosen && <option value="unchosen" disabled>Choose…</option>}
                <option value="">None: run on this machine</option>
                {flavor && !known && <option value={flavor}>{flavor}</option>}
                {listing?.flavors.map((f) => (
                  <option key={f.name} value={f.name} disabled={f.agent !== 'claude'}>
                    {f.name}
                    {f.agent !== 'claude' ? ` (${f.agent}: not supported)` : !f.imageBuilt ? ' (image not built)' : f.imageStale ? ' (image out of date)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {unchosen && <p>Choose where this project's sessions run. The project setup starts after that.</p>}
            {listing && !listing.available && <p className="error">isolagent: {listing.reason}</p>}
            <p className="muted">
              Applies to sessions started from now on. A sandbox keeps its own session history and Claude login: log in
              once with <code>isolagent run --flavor {flavor || '<flavor>'}</code> in a terminal. Tasks started before the
              project had a sandbox can't continue in it.
            </p>
            <label className="sandbox-flavor">
              <span>GitHub account</span>
              <select value={githubUser} disabled={busy}
                onChange={(e) => act(() => api.setAccount(project.id, e.target.value || null, project.gitEmail ?? null))}>
                <option value="">gh's active account</option>
                {githubUser && !accounts.includes(githubUser) && <option value={githubUser}>{githubUser} (not logged in)</option>}
                {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="sandbox-flavor">
              <span>Git author email</span>
              <input type="email" value={email} placeholder="from the global git config" disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={() => email.trim() !== (project.gitEmail ?? '') && act(() => api.setAccount(project.id, project.githubUser ?? null, email.trim() || null))} />
            </label>
            <p className="muted">
              The account that <code>gh</code> and <code>git push</code> use in the sandbox, and that Steffe lists and
              opens pull requests with. The email is the sandbox's commit author. A sandbox takes both when it starts:
              restart one that has sessions running. Sessions on this machine keep your own gh and git setup.
            </p>
            {sandbox?.message && <p className={sandbox.state === 'error' ? 'error' : ''}>{sandbox.message}</p>}
            {sandbox?.warning && <p className="muted">{sandbox.warning}</p>}
            {sandbox?.approval && (
              <div className="sandbox-approval">
                <h3>Approve {sandbox.approval.file}</h3>
                <p className="muted">
                  It changed since you last approved it. It can let the sandbox reach more hosts and ports, share
                  folders, run setup commands and pick the flavor, and agents can edit it.
                </p>
                <pre className="mono">{sandbox.approval.diff}</pre>
                <button className="primary" disabled={busy}
                  onClick={() => act(() => api.approveSandbox(project.id, sandbox.approval!.hash))}>
                  Approve and start
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
