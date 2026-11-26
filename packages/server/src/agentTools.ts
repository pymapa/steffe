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
  nameTask(name: string): Promise<string>;
  startPlanning(brief: string, branchType: BranchType): Promise<string>;
  startWork(spec: string, items: PlanItemInput[], branchType: BranchType): Promise<string>;
  checkoutPr(number: number): Promise<string>;
  handoff(): Promise<string>;
  approvePlan(): Promise<string>;
  addItems(items: PlanItemInput[]): Promise<string>;
  spawnAgent(role: string, itemId: string | null, brief: string): Promise<string>;
  messageAgent(name: string, text: string): Promise<string>;
  closeAgent(name: string): Promise<string>;
  updateItem(itemId: string, status: string, note: string | undefined): Promise<string>;
  mergeItem(itemId: string): Promise<string>;
  taskStatus(): Promise<string>;
  askUser(question: string, images: string[], links: { label: string; url: string }[]): Promise<string>;
  finish(prTitle: string, report: string, draft: boolean, keepValidators: boolean, pr: number | null): Promise<string>;
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

export const BRANCH_TYPES = ['feature', 'fix', 'chore', 'refactor', 'docs', 'design'] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

const branchType = z
  .enum(BRANCH_TYPES)
  .default('feature')
  .describe('kind of change; the task branch is named <branch_type>/<the name you gave with name_task>');

export function steffeServer(host: ToolHost, allowed: string[]): McpSdkServerConfigWithInstance {
  const all = [
    tool(
      'update_plan',
      'Create or replace the task plan shown to the user on the board. Call with the full plan every time.',
      { spec: z.string().describe('markdown spec'), items: z.array(planItem) },
      wrap(({ spec, items }) => host.updatePlan(spec, items)),
    ),
    tool(
      'name_task',
      "Name the task once you understand what it is about: before start_work or start_planning (which refuse without it), and before you answer a question. The name is what the user sees in the task list, and the branch is named after it (<branch_type>/<name>). Name the subject, not the request: 'My week single table', 'Sandbox CPU limits', not the user's sentence cut short. Call it again when the task turns out to be about something else; the branch keeps its name once it exists. Once the task has a pull request it is named after that ('#<number> <PR title>') and name_task refuses.",
      { name: z.string().describe('2 to 4 words, at most 30 characters, no type prefix ("Login redirect", not "Fix login redirect bug")') },
      wrap(({ name }) => host.nameTask(name)),
    ),
    tool(
      'start_planning',
      'Triage decision, only when the user asked for a planner (or agreed to your suggestion of one): start an autonomous planner. Its questions (ask the user in chat, answer with message_agent) and its report when the plan is ready arrive as [steffe] messages.',
      {
        brief: z
          .string()
          .describe('what the planner should know beyond the original request: what you learned from the user and the code, your sizing, open questions'),
        branch_type: branchType,
      },
      wrap(({ brief, branch_type }) => host.startPlanning(brief, branch_type)),
    ),
    tool(
      'start_work',
      'Default triage decision for a change request: write the plan yourself (usually one item; a single design item for "just the design", design items only when the user asked for a design) and start executing it right away, without a planner or plan approval. Then spawn the developer or designer.',
      { spec: z.string().describe('markdown spec: goal, approach, how it is verified'), items: z.array(planItem), branch_type: branchType },
      wrap(({ spec, items, branch_type }) => host.startWork(spec, items, branch_type)),
    ),
    tool(
      'checkout_pr',
      "Triage decision, when the user asks to check out, test, hand off or continue an existing pull request that no Steffe task owns: this task takes the PR over. Its branch becomes the task branch (fetched from origin) and the task goes to review, as if it had opened the PR. Nothing is checked out: call handoff for that. add_items then reopens the task for changes, and finish pushes them to the same PR.",
      { number: z.number().int().positive().describe('the pull request number') },
      wrap(({ number }) => host.checkoutPr(number)),
    ),
    tool(
      'handoff',
      "Hand the finished task (review, done or cancelled) to the user for local testing, when they ask for it: the task's worktrees are removed and its branch is checked out in their main checkout. The same as the Handoff button. Refuses when the main checkout or a worktree has uncommitted changes.",
      {},
      wrap(() => host.handoff()),
    ),
    tool(
      'approve_plan',
      "Approve the planner's plan after the user explicitly approved it in chat. Closes the planner and returns the plan to execute.",
      {},
      wrap(() => host.approvePlan()),
    ),
    tool(
      'add_items',
      'Add work items to the plan while executing, e.g. code items after the user approved a design-only start and wants it built. On a finished task (review or done, also after checkout_pr) it reopens the task for changes the user asks for (start_work and start_planning only work in triage): the task executes again; finish afterwards updates the same PR. Same shape as plan items.',
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
      "Finish the task: push the task branch and open the pull request with the report as its description (or update the task's open one). Call when every item is merged and validated. When the task's earlier pull request has been merged in the meantime, finish moves the commits made since onto a new branch off the base and opens a new pull request for them: don't do that by hand. A design-only task (only design items) finishes without a PR; the report records the design.",
      {
        prTitle: z.string().describe('title of the pull request; the task is then shown as "#<number> <prTitle>"'),
        report: z.string().describe('markdown report: summary, changes, verification, docs, follow-ups'),
        draft: z.boolean().default(false),
        keep_validators: z
          .boolean()
          .default(false)
          .describe(
            'only when the user asked to wrap up now: reviewers/testers still running keep going after the PR is opened instead of blocking finish; their reports wake you in review',
          ),
        pr: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "only when the task's work is already in an open pull request on another branch than the task's (one you or the user opened by hand): its number. The task moves to that branch and PR, and the report is posted there as a comment",
          ),
      },
      wrap(({ prTitle, report, draft, keep_validators, pr }) => host.finish(prTitle, report, draft, keep_validators, pr ?? null)),
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

/** The facilitator's tool. The behaviour lives in RetroManager. */
export interface RetroHost {
  saveRetro(analysis: RetroInput): Promise<string>;
}

const retroInput = z.object({
  summary: z.string().describe('markdown, a few sentences: how the round went and the one or two things most worth changing'),
  rating: z.enum(['smooth', 'bumpy', 'rough']).describe('smooth: nothing notable went wrong; bumpy: it got there with avoidable detours; rough: major rework, failures or waiting'),
  went_well: z.array(z.string()).default([]).describe('what to keep doing, one line each'),
  findings: z
    .array(
      z.object({
        kind: z
          .enum(['slow', 'failure', 'rework', 'waste', 'friction'])
          .describe('slow: took far longer than it should; failure: something broke; rework: done twice; waste: effort that bought nothing; friction: a rule, prompt or missing setup got in the way'),
        title: z.string().describe('one line, specific enough to recognise the same problem in another task'),
        detail: z.string().describe('what happened, with evidence: agent, time, command, error'),
        agent: z.string().optional().describe('agent name it happened to, e.g. developer-1'),
        itemId: z.string().optional(),
        minutes: z.number().optional().describe('rough time it cost'),
        suggestion: z.string().optional().describe('the concrete change that would prevent it, and where: a Steffe role or skill, the project setup, or the project (CLAUDE.md, scripts, tests)'),
      }),
    )
    .describe('most costly first; empty when the round was smooth'),
});
export type RetroInput = z.infer<typeof retroInput>;

export function retroServer(host: RetroHost): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'steffe',
    version: '0.1.0',
    tools: [
      tool(
        'save_retro',
        'Store your retro of the task. Call exactly once, when your analysis is complete, then end your turn.',
        retroInput.shape,
        wrap((analysis: RetroInput) => host.saveRetro(analysis)),
      ),
    ],
  });
}
