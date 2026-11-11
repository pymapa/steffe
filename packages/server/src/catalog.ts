import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  CatalogEntry,
  CatalogSource,
  CreateCatalogEntryRequest,
  ProjectCatalog,
  SaveCatalogEntryRequest,
} from '@steffe/shared';
import { PLUGIN_DIR, ROLES_DIR } from './roles.js';
import { parseFrontmatter } from './frontmatter.js';

type Kind = CatalogEntry['kind'];

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

async function entry(kind: Kind, source: CatalogSource, path: string, fallbackName: string): Promise<CatalogEntry | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      kind,
      source,
      name: frontmatter.name || fallbackName,
      description: frontmatter.description ?? '',
      path,
      frontmatter,
      body,
      raw,
    };
  } catch {
    return null;
  }
}

function dirFor(kind: Kind, source: CatalogSource, projectPath: string): string {
  if (source === 'steffe') return kind === 'agent' ? ROLES_DIR : join(PLUGIN_DIR, 'skills');
  return join(projectPath, '.claude', kind === 'agent' ? 'agents' : 'skills');
}

/** Agents are `<dir>/<name>.md`, skills are `<dir>/<name>/SKILL.md`. */
function pathFor(kind: Kind, source: CatalogSource, projectPath: string, name: string): string {
  const dir = dirFor(kind, source, projectPath);
  return kind === 'agent' ? join(dir, `${name}.md`) : join(dir, name, 'SKILL.md');
}

async function agentsIn(dir: string, source: CatalogSource): Promise<CatalogEntry[]> {
  const files = (await safeReaddir(dir)).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const out = await Promise.all(files.map((f) => entry('agent', source, join(dir, f), basename(f, '.md'))));
  return out.filter((e): e is CatalogEntry => e !== null);
}

async function skillsIn(dir: string, source: CatalogSource): Promise<CatalogEntry[]> {
  const out = await Promise.all((await safeReaddir(dir)).map((d) => entry('skill', source, join(dir, d, 'SKILL.md'), d)));
  return out.filter((e): e is CatalogEntry => e !== null);
}

/** Steffe's roles and skills, plus the project's own Claude Code agents and skills. */
export async function loadCatalog(projectPath: string): Promise<ProjectCatalog> {
  const [cAgents, pAgents, cSkills, pSkills] = await Promise.all([
    agentsIn(dirFor('agent', 'steffe', projectPath), 'steffe'),
    agentsIn(dirFor('agent', 'project', projectPath), 'project'),
    skillsIn(dirFor('skill', 'steffe', projectPath), 'steffe'),
    skillsIn(dirFor('skill', 'project', projectPath), 'project'),
  ]);
  return { agents: [...cAgents, ...pAgents], skills: [...cSkills, ...pSkills] };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function title(name: string): string {
  return name.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function template(req: CreateCatalogEntryRequest): string {
  const desc = oneLine(req.description) || 'TODO: one line saying what this does and when to use it.';
  if (req.kind === 'skill') {
    return `---
name: ${req.name}
description: ${desc}
---

# ${title(req.name)}

TODO: the instructions Claude follows when this skill is used.
`;
  }
  if (req.source === 'steffe') {
    return `---
name: ${req.name}
description: ${desc}
model: inherit
tools: report
disallowedTools:
writable: none
port: false
---

# Role: ${title(req.name)} (Steffe)

You are a **${req.name}** agent in a Steffe task. The orchestrator gives you
an assignment and you run unattended.

TODO: what this role does, how it works, and what a good result looks like.

Finish by calling \`report\` with an outcome (\`success\`, \`failure\`,
\`blocked\`) and a summary the orchestrator can act on.
`;
  }
  return `---
name: ${req.name}
description: ${desc}
model: inherit
---

TODO: the system prompt for this subagent: its role, how it works, and what it returns.
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Create a new agent or skill from a template. Fails if it already exists. */
export async function createCatalogEntry(projectPath: string, req: CreateCatalogEntryRequest): Promise<CatalogEntry> {
  if (!NAME.test(req.name)) throw new Error('name must be lowercase letters, digits and dashes');
  const path = pathFor(req.kind, req.source, projectPath, req.name);
  if (await exists(path)) throw new Error(`${req.kind} "${req.name}" already exists at ${path}`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, template(req), { flag: 'wx' });
  return (await entry(req.kind, req.source, path, req.name))!;
}

/** Overwrite an existing agent or skill file with edited contents. */
export async function saveCatalogEntry(projectPath: string, req: SaveCatalogEntryRequest): Promise<CatalogEntry> {
  if (!NAME.test(req.name)) throw new Error('invalid name');
  const path = pathFor(req.kind, req.source, projectPath, req.name);
  if (!(await exists(path))) throw new Error(`${req.kind} "${req.name}" does not exist`);
  const { frontmatter } = parseFrontmatter(req.raw);
  if (!frontmatter.name) throw new Error('the file needs YAML frontmatter with a name');
  if (frontmatter.name !== req.name) throw new Error(`frontmatter name "${frontmatter.name}" must stay "${req.name}"`);
  await writeFile(path, req.raw.endsWith('\n') ? req.raw : `${req.raw}\n`);
  return (await entry(req.kind, req.source, path, req.name))!;
}
