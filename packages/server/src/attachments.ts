import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Attachment } from '@steffe/shared';
import { WORKTREES_DIR, projectWorktrees } from './dataDir.js';

const FOLDER = '.attachments';
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Where a project's attached files are saved. Under its worktrees folder, which a sandboxed
 * project shares into its sandbox, so a session sees them at the same path on either side.
 */
export const attachmentsDir = (projectId: string) => join(projectWorktrees(projectId), FOLDER);

/**
 * Save the attachments Claude can't take as a content block (Office documents, archives, large
 * text or PDFs) to disk, each in a folder of its own so it keeps its name. The session is told
 * the path and opens the file with its own tools.
 */
export async function storeFiles(projectId: string, attachments: Attachment[]): Promise<Attachment[]> {
  return Promise.all(
    attachments.map(async (a) => {
      if (a.mediaType !== 'application/octet-stream') return a;
      const dir = join(attachmentsDir(projectId), randomUUID());
      await mkdir(dir, { recursive: true });
      const name = basename(a.name.replace(/[\\/\0]/g, '_')).replace(/^\.+/, '') || 'file';
      const path = join(dir, name);
      await writeFile(path, Buffer.from(a.data, 'base64'));
      return { ...a, data: '', path };
    }),
  );
}

/** Remove saved attachments older than a month, in every project. */
export async function pruneAttachments(): Promise<void> {
  const list = (dir: string) => readdir(dir).catch(() => [] as string[]);
  for (const project of await list(WORKTREES_DIR)) {
    const root = join(WORKTREES_DIR, project, FOLDER);
    for (const id of await list(root)) {
      const s = await stat(join(root, id)).catch(() => null);
      if (s && Date.now() - s.mtimeMs > KEEP_MS) await rm(join(root, id), { recursive: true, force: true });
    }
  }
}
