import type { Project, ProjectSetup, SessionSummary } from '@steffe/shared';
import { setupServer, type RoleWiringInput } from './agentTools.js';
import { loadCatalog } from './catalog.js';
import { isGitRepo } from './git.js';
import type { ProjectStore } from './projects.js';
import { FACILITATOR_ROLE, ROLES_DIR, getRole, loadRoles, type RoleDefinition } from './roles.js';
import type { Sandboxes } from './isolagent.js';
import type { ManagedSession } from './session.js';
import type { SessionManager } from './sessionManager.js';

/** The setup agent's role. It runs outside tasks and is never spawned in one. */
export const SETUP_ROLE = 'setup';

const canDelegate = (r: RoleDefinition) => !r.disallowedTools.some((t) => t === 'Agent' || t === 'Task');

/** The part of a task agent's system prompt that tells its role how to use the project's own agents and skills. */
export function wiringText(project: Project, role: string): string {
  const w = project.setup?.roles.find((r) => r.role === role);
  if (!w) return '';
  const names = (xs: string[]) => xs.map((x) => `\`${x}\``).join(', ');
  const lines = [`## This project's agents and skills for your role`, `(from the project setup the user accepted in Steffe)`];
  if (w.skills.length) lines.push(`- Project skills to use: ${names(w.skills)} (Skill tool)`);
  if (w.agents.length) lines.push(`- Project subagents to delegate to: ${names(w.agents)} (Agent tool)`);
  lines.push('', w.guidance);
  return lines.join('\n');
}

/**
 * Runs a project's setup agent: it reads the project's agents, skills and
 * tooling and proposes how Steffe's roles should use them. The user chats with
 * it and accepts the proposal; tasks then apply it (see wiringText).
 */
export class ProjectSetupManager {
  /** projectId -> live setup agent */
  private readonly live = new Map<string, ManagedSession>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly projects: ProjectStore,
    private readonly sandboxes: Sandboxes,
  ) {}

  private must(projectId: string): Project {
    const p = this.projects.get(projectId);
    if (!p) throw new Error('project not found');
    return p;
  }

  private changed(project: Project): Project {
    this.sessions.broadcast({ type: 'project.updated', project });
    return project;
  }

  /** Start (or restart) the setup agent for a project. */
  async analyze(projectId: string): Promise<SessionSummary> {
    const project = this.must(projectId);
    if (!(await isGitRepo(project.path))) throw new Error('setup is for git repositories (Steffe tasks need one)');
    this.stop(projectId);
    const role = await getRole(SETUP_ROLE);
    const session = this.sessions.create(
      {
        projectId,
        prompt: await this.brief(project),
        model: process.env.STEFFE_FORCE_MODEL || role.model || undefined,
        permissionMode: 'default',
        title: `setup · ${project.name}`,
      },
      project.path,
      {
        taskId: null,
        role: SETUP_ROLE,
        systemPromptAppend: role.prompt,
        mcpServers: { steffe: setupServer({ proposeSetup: (...a) => this.propose(projectId, ...a) }) },
        disallowedTools: role.disallowedTools,
        // Only to write what it suggested, when the user asks (see the role).
        writableRoots: role.writable === 'cwd' ? [project.path] : [],
      },
      await this.sandboxes.session(project),
    );
    this.live.set(projectId, session);
    return session.summary();
  }

  async accept(projectId: string): Promise<Project> {
    const project = this.must(projectId);
    if (!project.setupProposal) throw new Error('there is no proposal to accept');
    // The agent stays: the user can keep talking to it (revise, write a suggested skill).
    return this.changed(await this.projects.update(projectId, { setup: project.setupProposal, setupProposal: null }));
  }

  async dismiss(projectId: string): Promise<Project> {
    this.must(projectId);
    this.stop(projectId);
    return this.changed(await this.projects.update(projectId, { setupProposal: null }));
  }

  /** Stop applying the accepted setup to new task agents. */
  async clear(projectId: string): Promise<Project> {
    this.must(projectId);
    return this.changed(await this.projects.update(projectId, { setup: null }));
  }

  stop(projectId: string): void {
    const s = this.live.get(projectId);
    this.live.delete(projectId);
    if (s) this.sessions.remove(s.id);
  }

  private async propose(projectId: string, summary: string, roles: RoleWiringInput[], suggestions: string[]): Promise<string> {
    const project = this.must(projectId);
    const known = await loadRoles();
    const catalog = await loadCatalog(project.path);
    const skills = new Set(catalog.skills.filter((e) => e.source === 'project').map((e) => e.name));
    const agents = new Set(catalog.agents.filter((e) => e.source === 'project').map((e) => e.name));
    const errors: string[] = [];
    for (const w of roles) {
      const role = known.get(w.role);
      if (!role || w.role === SETUP_ROLE || w.role === FACILITATOR_ROLE) {
        errors.push(`unknown role "${w.role}"`);
        continue;
      }
      for (const s of w.skills) if (!skills.has(s)) errors.push(`${w.role}: no project skill "${s}"`);
      for (const a of w.agents) if (!agents.has(a)) errors.push(`${w.role}: no project agent "${a}"`);
      if (w.agents.length && !canDelegate(role)) errors.push(`${w.role} cannot use subagents (no Agent tool); use guidance instead`);
    }
    if (new Set(roles.map((w) => w.role)).size !== roles.length) errors.push('list each role once');
    if (errors.length) throw new Error(`proposal not saved:\n- ${errors.join('\n- ')}`);

    const proposal: ProjectSetup = { summary, roles, suggestions, updatedAt: new Date().toISOString() };
    this.changed(await this.projects.update(projectId, { setupProposal: proposal }));
    return 'Proposal saved and shown to the user, who accepts it in the UI. Summarise it briefly in your reply.';
  }

  private async brief(project: Project): Promise<string> {
    const roles = [...(await loadRoles()).values()].filter((r) => r.name !== SETUP_ROLE && r.name !== FACILITATOR_ROLE);
    const catalog = await loadCatalog(project.path);
    const own = (xs: typeof catalog.agents) => xs.filter((e) => e.source === 'project');
    const list = (xs: typeof catalog.agents) =>
      xs.length ? xs.map((e) => `- **${e.name}** (${e.path}): ${e.description || 'no description'}`) : ['- none'];
    return [
      `[steffe] The user opened the project **${project.name}** at ${project.path}. Read its agents, skills and tooling, and propose how Steffe's roles should use them (propose_setup).`,
      ``,
      `## Steffe roles`,
      ...roles.map(
        (r) =>
          `- **${r.name}**: ${r.description} (${r.writable === 'cwd' ? 'edits code' : 'read only'}; ${canDelegate(r) ? 'can use subagents' : 'no subagents'}${r.mcp.length ? `; MCP: ${r.mcp.join(', ')}` : ''})`,
      ),
      ``,
      `Their full definitions are in ${ROLES_DIR}; read one if you need its exact workflow.`,
      ``,
      `## Project subagents (.claude/agents)`,
      ...list(own(catalog.agents)),
      ``,
      `## Project skills (.claude/skills)`,
      ...list(own(catalog.skills)),
      ...(project.setup
        ? [``, `## Currently accepted setup (revise it)`, '```json', JSON.stringify(project.setup.roles, null, 2), '```']
        : []),
    ].join('\n');
  }
}
