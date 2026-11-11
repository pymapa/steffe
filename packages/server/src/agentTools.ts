import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Steffe's in-process MCP tools. Agents see them as mcp__steffe__<name>.
 * Each agent session gets its own server instance bound to its identity, and
 * only the tools its role lists. The behaviour lives in TaskManager; this file
 * only declares schemas and adapts results.
 */
export interface ToolHost {
  updatePlan(spec: string, items: PlanItemInput[]): Promise<string>;
  startPlanning(brief: string): Promise<string>;
  startWork(spec: string, items: PlanItemInput[]): Promise<string>;
  approvePlan(): Promise<string>;
  addItems(items: PlanItemInput[]): Promise<string>;
  spawnAgent(role: string, itemId: string | null, brief: string): Promise<string>;
  messageAgent(name: string, text: string): Promise<string>;
  closeAgent(name: string): Promise<string>;
  updateItem(itemId: string, status: string, note: string | undefined): Promise<string>;
  mergeItem(itemId: string): Promise<string>;
  taskStatus(): Promise<string>;
  askUser(question: string, images: string[], links: { label: string; url: string }[]): Promise<string>;
  finish(prTitle: string, report: string, draft: boolean): Promise<string>;
  report(outcome: string, summary: string): Promise<string>;
  askOrchestrator(question: string): Promise<string>;
}

const planItem = z.object({
  id: z.string().describe('short stable id, e.g. "api-endpoint"'),
  title: z.string(),
  description: z.string().describe('enough context for a developer who has not seen the planning chat'),
  acceptanceCriteria: z.array(z.string()),
  dependsOn: z.array(z.string()).default([]),
  kind: z
    .enum(['code', 'design'])
    .default('code')
    .describe('design: a designer mocks it up in the project UI for the user to approve before the code items that depend on it; never merged'),
  mode: z.enum(['worktree', 'shared']).default('worktree'),
  validators: z.array(z.enum(['reviewer', 'tester'])).default(['reviewer']).describe('[] for design items: the user approves those'),
});
export type PlanItemInput = z.infer<typeof planItem>;

const ITEM_STATUS = ['todo', 'in_progress', 'in_review', 'testing', 'needs_fix', 'awaiting_user', 'blocked', 'done'] as const;

function wrap<A>(fn: (args: A) => Promise<string>) {
  return async (args: A) => {
    try {
      return { content: [{ type: 'text' as const, text: await fn(args) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  };
}

export function steffeServer(host: ToolHost, allowed: string[]): McpSdkServerConfigWithInstance {
  const all = [
    tool(
      'update_plan',
      'Create or replace the task plan shown to the user on the board. Call with the full plan every time.',
      { spec: z.string().describe('markdown spec'), items: z.array(planItem) },
      wrap(({ spec, items }) => host.updatePlan(spec, items)),
    ),
    tool(
      'start_planning',
      'Triage decision for work that needs a plan: start an autonomous planner. Its questions (ask the user in chat, answer with message_agent) and its report when the plan is ready arrive as [steffe] messages.',
      {
        brief: z
          .string()
          .describe('what the planner should know beyond the original request: what you learned from the user and the code, your sizing, open questions'),
      },
      wrap(({ brief }) => host.startPlanning(brief)),
    ),
    tool(
      'start_work',
      'Triage decision for trivial work, or a design-only request: set a small plan yourself (usually one item; a single design item for "just the design") and start executing it right away, without a planner or plan approval. Then spawn the developer or designer.',
      { spec: z.string().describe('markdown spec: goal, approach, how it is verified'), items: z.array(planItem) },
      wrap(({ spec, items }) => host.startWork(spec, items)),
    ),
    tool(
      'approve_plan',
      "Approve the planner's plan after the user explicitly approved it in chat. Closes the planner and returns the plan to execute.",
      {},
      wrap(() => host.approvePlan()),
    ),
    tool(
      'add_items',
      'Add work items to the plan while executing, e.g. code items after the user approved a design-only start and wants it built. Same shape as plan items.',
      { items: z.array(planItem) },
      wrap(({ items }) => host.addItems(items)),
    ),
    tool(
      'spawn_agent',
      'Start an agent. Returns its name. It works asynchronously and its report arrives later as a [steffe] message. Developers on worktree items get their own branch/worktree; reviewer/tester of an unmerged item run in that worktree; without itemId they run on the task branch.',
      {
        role: z.string().describe('developer, reviewer, tester, ...'),
        itemId: z.string().optional().describe('work item this agent works on'),
        brief: z.string().describe('the full instructions for the agent'),
      },
      wrap(({ role, itemId, brief }) => host.spawnAgent(role, itemId ?? null, brief)),
    ),
    tool(
      'message_agent',
      'Send follow-up instructions to an existing agent (e.g. fixes to the developer who wrote the code). It keeps its context and reports again.',
      { name: z.string(), text: z.string() },
      wrap(({ name, text }) => host.messageAgent(name, text)),
    ),
    tool(
      'close_agent',
      'Stop an agent whose work is finished.',
      { name: z.string() },
      wrap(({ name }) => host.closeAgent(name)),
    ),
    tool(
      'update_item',
      'Set a work item status on the board, with an optional note. Setting needs_fix counts a fix round; after 3 rounds the item is blocked.',
      { itemId: z.string(), status: z.enum(ITEM_STATUS), note: z.string().optional() },
      wrap(({ itemId, status, note }) => host.updateItem(itemId, status, note)),
    ),
    tool(
      'merge_item',
      "Merge a validated worktree item's branch into the task branch. Reports conflicts instead of leaving a half-merged state.",
      { itemId: z.string() },
      wrap(({ itemId }) => host.mergeItem(itemId)),
    ),
    tool(
      'task_status',
      'Current board, agents and their states.',
      {},
      wrap(() => host.taskStatus()),
    ),
    tool(
      'ask_user',
      'Escalate a question to the user, or hand them a design to approve. Returns immediately; end your turn and the answer arrives as a [steffe] message.',
      {
        question: z.string(),
        images: z
          .array(z.string())
          .optional()
          .describe('absolute paths of screenshots under $STEFFE_ARTIFACTS to show with the question (e.g. from a designer report)'),
        links: z
          .array(z.object({ label: z.string(), url: z.string().describe('http://localhost:<port>/...') }))
          .optional()
          .describe("live pages for the user to open, e.g. the designer's mock running in the app"),
      },
      wrap(({ question, images, links }) => host.askUser(question, images ?? [], links ?? [])),
    ),
    tool(
      'finish',
      'Finish the task: push the task branch and open the pull request with the report as its description. Call when every item is merged and validated. A design-only task (only design items) finishes without a PR; the report records the design.',
      {
        prTitle: z.string(),
        report: z.string().describe('markdown report: summary, changes, verification, docs, follow-ups'),
        draft: z.boolean().default(false),
      },
      wrap(({ prTitle, report, draft }) => host.finish(prTitle, report, draft)),
    ),
    tool(
      'ask_orchestrator',
      'Ask the orchestrator, who knows the whole plan and the user, a question your brief does not settle. Returns immediately; end your turn and the answer arrives as a new message. Do not call report in the meantime.',
      {
        question: z
          .string()
          .describe('the decision you need, the options you see, what you would pick and why, and what you already checked'),
      },
      wrap(({ question }) => host.askOrchestrator(question)),
    ),
    tool(
      'report',
      'Report your result to the orchestrator. Call exactly once when your current assignment is finished, then end your turn.',
      {
        outcome: z.enum(['success', 'failure', 'blocked']),
        summary: z.string().describe('markdown: what you did/checked, evidence, findings'),
      },
      wrap(({ outcome, summary }) => host.report(outcome, summary)),
    ),
  ];
  return createSdkMcpServer({
    name: 'steffe',
    version: '0.1.0',
    tools: all.filter((t) => allowed.includes(t.name)),
  });
}

/** Tools of a project's setup agent. The behaviour lives in ProjectSetupManager. */
export interface SetupHost {
  proposeSetup(summary: string, roles: RoleWiringInput[], suggestions: string[]): Promise<string>;
}

const roleWiring = z.object({
  role: z.string().describe('Steffe role name, e.g. "tester"'),
  skills: z.array(z.string()).default([]).describe('names of project skills (.claude/skills) this role should use'),
  agents: z.array(z.string()).default([]).describe('names of project subagents (.claude/agents) this role should delegate to'),
  guidance: z
    .string()
    .describe('markdown instructions added to the role in this project: when and how to use the skills and agents above, and anything else role-specific'),
});
export type RoleWiringInput = z.infer<typeof roleWiring>;

export function setupServer(host: SetupHost): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'steffe',
    version: '0.1.0',
    tools: [
      tool(
        'propose_setup',
        "Show the user your proposal for wiring the project's agents and skills into Steffe roles. Call with the full proposal every time; it replaces the previous one. The user accepts it in the UI.",
        {
          summary: z.string().describe('markdown: what the project provides and why you wired it this way'),
          roles: z.array(roleWiring).describe('one entry per role that should use something; leave out roles with nothing to add'),
          suggestions: z
            .array(z.string())
            .default([])
            .describe('agents or skills the project could add so Steffe agents work better (e.g. a skill for starting the app)'),
        },
        wrap(({ summary, roles, suggestions }) => host.proposeSetup(summary, roles, suggestions)),
      ),
    ],
  });
}
