import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Ports handed to task agents start here, well away from common dev-server defaults. */
const FIRST = Number(process.env.STEFFE_AGENT_PORT_BASE ?? 41000);
const LAST = FIRST + 999;
const reserved = new Set<number>();

// A port only counts as free if nothing listens on it on any of these. On macOS
// binding `::` succeeds even when another app holds 127.0.0.1, which would
// silently shadow that app on localhost.
const ALL_HOSTS = ['127.0.0.1', '0.0.0.0', '::1', '::'];

function freeOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    // Only EADDRINUSE/EACCES mean taken; e.g. EADDRNOTAVAIL means no IPv6 here.
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code !== 'EADDRINUSE' && e.code !== 'EACCES'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

export async function isFreeEverywhere(port: number): Promise<boolean> {
  for (const h of ALL_HOSTS) if (!(await freeOn(port, h))) return false;
  return true;
}

/** First port from `start` that nothing listens on (used for Steffe's own server port). */
export async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 100; p++) if (await isFreeEverywhere(p)) return p;
  throw new Error(`no free port in ${start}-${start + 99}`);
}

/**
 * Reserve a free port for an agent. Ports are spaced 10 apart so an app that
 * needs a couple of extra ports (PORT+1 for an API, ...) still won't collide;
 * the agent is told PORT..PORT+9 are its own, so all ten must be free.
 */
export async function reservePort(): Promise<number> {
  next: for (let p = FIRST; p <= LAST; p += 10) {
    if (reserved.has(p)) continue;
    for (let q = p; q < p + 10; q++) if (!(await isFreeEverywhere(q))) continue next;
    reserved.add(p);
    return p;
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
