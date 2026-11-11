import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Ports handed to task agents start here, well away from common dev-server defaults. */
const FIRST = Number(process.env.STEFFE_AGENT_PORT_BASE ?? 41000);
const LAST = FIRST + 999;
const reserved = new Set<number>();

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * Reserve a free port for an agent. Ports are spaced 10 apart so an app that
 * needs a couple of extra ports (PORT+1 for an API, ...) still won't collide.
 */
export async function reservePort(): Promise<number> {
  for (let p = FIRST; p <= LAST; p += 10) {
    if (reserved.has(p)) continue;
    if (await isFree(p)) {
      reserved.add(p);
      return p;
    }
  }
  throw new Error('no free agent ports');
}

/** Mark a port as taken without checking (used when restoring a persisted task). */
export function claimPort(port: number): void {
  reserved.add(port);
}

export function releasePort(port: number | null): void {
  if (port != null) reserved.delete(port);
}

/**
 * Stop whatever still listens on an agent's ports (port..port+9), e.g. a
 * designer's mock app left running for the user. Those ports are reserved for
 * that one agent, so anything listening there is its own leftover.
 */
export async function stopListeners(port: number | null): Promise<number[]> {
  if (port == null) return [];
  const pids = new Set<number>();
  for (let p = port; p < port + 10; p++) {
    const out = await exec('lsof', ['-nP', '-t', `-iTCP:${p}`, '-sTCP:LISTEN']).then(
      (r) => r.stdout,
      () => '', // lsof exits 1 when nothing listens
    );
    for (const line of out.split('\n')) {
      const pid = Number(line.trim());
      if (pid && pid !== process.pid) pids.add(pid);
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  return [...pids];
}
