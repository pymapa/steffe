import { useEffect, useState } from 'react';
import type { RetroRecord, Task } from '@steffe/shared';
import { api } from '../lib/api';
import { Markdown } from './Markdown';

const min = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** The task's latest retro: what the facilitator found, and the numbers Steffe measured. */
export function RetroView({ task, canRun }: { task: Task; canRun: boolean }) {
  const [record, setRecord] = useState<RetroRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const retro = task.retro;

  useEffect(() => {
    setRecord(null);
    if (retro?.recordId) api.taskRetro(task.id).then(setRecord).catch((e) => setError(String(e)));
  }, [task.id, retro?.recordId]);

  const run = () => {
    setError(null);
    api.runRetro(task.id).catch((e) => setError(String(e)));
  };
  const runButton = canRun && retro?.state !== 'running' && (
    <button className="small" onClick={run} title="A facilitator agent reads the agents' transcripts and records what took long and what failed">
      {retro ? 'Run again' : 'Run retro'}
    </button>
  );

  return (
    <div className="pad retro">
      {error && <div className="error">{error}</div>}
      {!retro && <p className="muted">No retro yet. One runs by itself after the orchestrator finishes a round. {runButton}</p>}
      {retro?.state === 'running' && <p className="muted">The facilitator is reading the agents' transcripts…</p>}
      {retro?.state === 'failed' && <p className="error">The retro failed: {retro.error} {runButton}</p>}
      {record && (
        <>
          <div className="retro-head">
            <span className={`pill retro-${record.analysis.rating}`}>{record.analysis.rating}</span>
            <span className="muted">
              round {record.round} · {new Date(record.createdAt).toLocaleString()} · retro cost ${record.facilitator.costUsd.toFixed(2)}
            </span>
            {runButton}
          </div>
          <Markdown>{record.analysis.summary}</Markdown>

          <h3>Findings ({record.analysis.findings.length})</h3>
          {record.analysis.findings.length === 0 && <p className="muted">None.</p>}
          {record.analysis.findings.map((f, i) => (
            <div key={i} className="retro-finding">
              <div className="retro-finding-head">
                <span className={`pill retro-kind-${f.kind}`}>{f.kind}</span>
                <strong>{f.title}</strong>
                <span className="muted">
                  {[f.agent, f.itemId, f.minutes != null ? `~${f.minutes} min` : null].filter(Boolean).join(' · ')}
                </span>
              </div>
              <Markdown>{f.detail}</Markdown>
              {f.suggestion && <Markdown className="retro-suggestion">{`**Suggestion:** ${f.suggestion}`}</Markdown>}
            </div>
          ))}

          {record.analysis.wentWell.length > 0 && (
            <>
              <h3>Went well</h3>
              <ul>{record.analysis.wentWell.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </>
          )}

          <h3>Numbers</h3>
          <p className="muted">
            {min(record.metrics.wallMs)} wall time · {min(record.metrics.activeMs)} agent work · ${record.metrics.costUsd.toFixed(2)} ·{' '}
            {record.metrics.fixRounds} fix rounds · {record.metrics.toolCalls} tool calls, {record.metrics.toolErrors} errors
          </p>
          <table className="retro-table">
            <thead>
              <tr><th>Agent</th><th>Item</th><th>Active</th><th>Cost</th><th>Queued</th><th>Calls</th><th>Errors</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              {record.metrics.agents.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td>
                  <td>{a.itemId ?? ''}</td>
                  <td>{min(a.activeMs)}</td>
                  <td>${a.costUsd.toFixed(2)}</td>
                  <td>{a.waitMs != null && a.waitMs > 60_000 ? min(a.waitMs) : ''}</td>
                  <td>{a.toolCalls}</td>
                  <td>{a.toolErrors || ''}</td>
                  <td>{a.outcome ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {record.metrics.slowest.length > 0 && (
            <>
              <h3>Slowest tool calls</h3>
              <ul className="retro-slow">
                {record.metrics.slowest.map((s, i) => (
                  <li key={i}><span className="mono">{s.seconds}s</span> {s.agent} · {s.tool}: <span className="mono muted">{s.summary}</span></li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
