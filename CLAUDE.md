# Steffe

Local web UI that orchestrates Claude Code sessions via `@anthropic-ai/claude-agent-sdk`.
npm workspaces: `packages/shared` (types), `packages/server` (Hono + ws, port 4010),
`packages/web` (Vite + React, port 3000, proxies `/api` and `/ws` to the server).

## Commands

- `npm run dev` — both server and web with watch (`scripts/dev.mjs` picks free ports
  from 4010 / 3000 and wires the proxy)
- `npm run typecheck` — tsc across all packages (run before finishing a change)
- `npm run build --workspace=@steffe/web` — production build of the UI

## Model

Projects (opened folders, persisted in `~/.steffe/projects.json` by
`packages/server/src/projects.ts`) contain sessions (live SDK queries, in
memory) and tasks. A plain session's cwd is its project's path.

Tasks (`packages/server/src/tasks.ts`, persisted in `~/.steffe/tasks/`) are
teams of agent sessions working in git worktrees under `~/.steffe/worktrees/`.
The orchestrator is the user's only contact and the hub: it starts every task
in `triage`, in the project's main checkout (read only), with no branch or
worktree. It answers questions in chat, or by default writes the plan itself and goes
straight to execution (`start_work`). A planner (`start_planning`; the user
approves the plan in chat via `approve_plan` or in the UI) or a designer is
used only when the user asks for one; the orchestrator may suggest one when
the task would greatly benefit from it. Either one creates the task
branch and worktree. Every other agent runs
autonomously; its `report`s and `ask_orchestrator` questions are delivered to
the orchestrator as user messages. A finished task keeps its worktree for
local testing until the user clicks Handoff (`TaskManager.handoff`): the
worktree is removed and the task branch checked out in the main checkout. Roles live in `roles/*.md`, shared skills in `plugin/skills/`.
They stay project-agnostic; project knowledge comes from the target repo's
CLAUDE.md and skills.

Project setup (`packages/server/src/projectSetup.ts`): when a git repo is first
opened, a `setup` agent (`roles/setup.md`, never spawned in tasks) reads the
repo's `.claude` agents, skills and tooling and proposes, per role, which of
them to use and how (`propose_setup`). The user discusses it in chat and
accepts it in the UI; it is stored on the project (`setup` in projects.json)
and each task agent gets its role's wiring appended to its system prompt.

## Conventions

- All server <-> web types live in `packages/shared/src/index.ts`. Change the
  wire protocol there first, then both sides.
- `ManagedSession` (`packages/server/src/session.ts`) is the only place that
  runs SDK queries. Keep SDK message handling there; the rest of the server only
  sees `TranscriptEntry` / `SessionSummary`. The one exception is
  `agentTools.ts`, which declares Steffe's in-process MCP tools; their
  behaviour lives in `TaskManager` (and `ProjectSetupManager` for `propose_setup`).
- SDK types: verify against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  rather than from memory; the SDK moves fast.
- Smoke test a session change with a cheap model: `"model": "haiku"` and a
  trivial prompt against a scratch directory. For tasks, run the server with
  `STEFFE_FORCE_MODEL=haiku`, a different `PORT` and a scratch
  `STEFFE_DATA_DIR`, against a scratch git repo.
- At most `STEFFE_MAX_AGENTS` (default 4, 0 = no limit) task agents work at
  once across all tasks; further spawns are queued (`TaskAgent.state`
  `queued`) and started by `TaskManager.drain`.
