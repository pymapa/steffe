import { rename, rm, writeFile } from 'node:fs/promises';

let seq = 0;

/**
 * Write a file so readers only ever see the old or the new content: write a
 * sibling temp file, then rename it over the target. A plain writeFile
 * truncates first, so a kill (Ctrl-C, tsx watch restart) or an overlapping
 * write mid-way leaves an empty or half-written file behind.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${seq++}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
