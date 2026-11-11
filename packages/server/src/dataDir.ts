import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Steffe keeps projects, tasks and worktrees: $STEFFE_DATA_DIR, else
 * ~/.steffe. Installs from before the rename (Steffe was called Conductor)
 * keep using ~/.conductor whenever it exists, even if a ~/.steffe appeared
 * meanwhile: task worktrees are registered in the user's repos and Claude's
 * session history is keyed by those paths, so the directory can't simply be
 * moved, and silently switching would hide the user's projects and tasks.
 */
function resolve(): string {
  if (process.env.STEFFE_DATA_DIR) return process.env.STEFFE_DATA_DIR;
  const legacy = join(homedir(), '.conductor');
  if (existsSync(legacy)) {
    console.log(`[steffe] using data directory ${legacy} (from before the rename; see README)`);
    return legacy;
  }
  return join(homedir(), '.steffe');
}

export const DATA_DIR = resolve();
