import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { CreateProjectRequest, OpenProjectResult, Project } from '@steffe/shared';

import { DATA_DIR } from './dataDir.js';
import { writeFileAtomic } from './atomicWrite.js';

const FILE = join(DATA_DIR, 'projects.json');

/** Opened projects, persisted to ~/.steffe/projects.json. */
export class ProjectStore {
  private projects = new Map<string, Project>();

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(FILE, 'utf8')) as Project[];
      for (const p of raw) this.projects.set(p.id, p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async save(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFileAtomic(FILE, JSON.stringify(this.list(), null, 2));
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /** Open a folder as a project. Re-opening an existing path returns the existing project. */
  async open(req: CreateProjectRequest): Promise<OpenProjectResult> {
    const path = resolve(req.path);
    if (!(await stat(path)).isDirectory()) throw new Error(`${path} is not a directory`);
    const now = new Date().toISOString();
    let project = this.list().find((p) => p.path === path);
    const created = !project;
    if (project) {
      project.lastOpenedAt = now;
      if (req.name) project.name = req.name;
    } else {
      project = { id: randomUUID(), name: req.name ?? basename(path), path, createdAt: now, lastOpenedAt: now };
      this.projects.set(project.id, project);
    }
    await this.save();
    return { project, created };
  }

  async update(id: string, patch: Partial<Pick<Project, 'setup' | 'setupProposal' | 'isolagentFlavor' | 'githubUser' | 'gitEmail' | 'sandboxCpus' | 'sandboxMemMb' | 'sandboxStopped' | 'sandboxStateDir'>>): Promise<Project> {
    const p = this.projects.get(id);
    if (!p) throw new Error('project not found');
    Object.assign(p, patch);
    await this.save();
    return p;
  }

  async touch(id: string): Promise<Project | undefined> {
    const p = this.projects.get(id);
    if (!p) return undefined;
    p.lastOpenedAt = new Date().toISOString();
    await this.save();
    return p;
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.projects.delete(id);
    if (existed) await this.save();
    return existed;
  }
}
