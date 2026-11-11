import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DirectoryListing } from '@steffe/shared';

const SKIP = new Set(['node_modules', '.git', '.Trash', 'Library']);

/** List subdirectories of an absolute path. Hidden dirs are omitted unless requested. */
export async function listDirectories(input: string | undefined, showHidden: boolean): Promise<DirectoryListing> {
  const path = resolve(input && input.trim() ? input : homedir());
  const parent = dirname(path);
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .filter((e) => !SKIP.has(e.name))
      .map(async (e) => {
        const full = join(path, e.name);
        if (e.isSymbolicLink()) {
          try {
            if (!(await stat(full)).isDirectory()) return null;
          } catch {
            return null;
          }
        }
        const isGitRepo = await stat(join(full, '.git')).then(() => true, () => false);
        return { name: e.name, path: full, isGitRepo };
      }),
  );
  return {
    path,
    parent: parent === path ? null : parent,
    dirs: dirs
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
  };
}
