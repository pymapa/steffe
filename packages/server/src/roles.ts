import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.js';

/** Root of the Steffe repo: roles/ and plugin/ live here. */
export const STEFFE_HOME =
  process.env.STEFFE_HOME ?? fileURLToPath(new URL('../../../', import.meta.url));
export const ROLES_DIR = join(STEFFE_HOME, 'roles');
export const PLUGIN_DIR = join(STEFFE_HOME, 'plugin');

export interface RoleDefinition {
  name: string;
  description: string;
  /** null = inherit the task's default model */
  model: string | null;
  tools: string[];
  disallowedTools: string[];
  mcp: string[];
  writable: 'cwd' | 'none';
  port: boolean;
  prompt: string;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function parse(file: string, raw: string): RoleDefinition {
  const { frontmatter: fm, body } = parseFrontmatter(raw);
  if (!fm.name) throw new Error(`${file}: frontmatter needs a name`);
  return {
    name: fm.name,
    description: fm.description ?? '',
    model: !fm.model || fm.model === 'inherit' ? null : fm.model,
    tools: list(fm.tools),
    disallowedTools: list(fm.disallowedTools),
    mcp: list(fm.mcp),
    writable: fm.writable === 'cwd' ? 'cwd' : 'none',
    port: fm.port === 'true',
    prompt: body,
  };
}

/** Role definitions are re-read on every lookup so edits apply to the next agent without a restart. */
export async function loadRoles(): Promise<Map<string, RoleDefinition>> {
  const roles = new Map<string, RoleDefinition>();
  for (const f of await readdir(ROLES_DIR)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const role = parse(f, await readFile(join(ROLES_DIR, f), 'utf8'));
    roles.set(role.name, role);
  }
  return roles;
}

export async function getRole(name: string): Promise<RoleDefinition> {
  const role = (await loadRoles()).get(name);
  if (!role) throw new Error(`unknown role "${name}"`);
  return role;
}
