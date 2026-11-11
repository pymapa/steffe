# Steffe

Local web UI that orchestrates Claude Code sessions via `@anthropic-ai/claude-agent-sdk`.
npm workspaces: `packages/shared` (types), `packages/server` (Hono + ws, port 4010),
`packages/web` (Vite + React, port 5173, proxies `/api` and `/ws` to the server).

## Commands

- `npm run dev` — both server and web with watch
- `npm run typecheck` — tsc across all packages (run before finishing a change)
- `npm run build --workspace=@steffe/web` — production build of the UI

## Model

Projects (opened folders, persisted in `~/.steffe/projects.json` by
`packages/server/src/projects.ts`) contain sessions (live SDK queries, in
memory) and tasks. A plain session's cwd is its project's path.

Tasks (`packages/server/src/tasks.ts`, persisted in `~/.steffe/tasks/`) are
teams of agent sessions working in git worktrees under `~/.steffe/worktrees/`.
The orchestrator is the user's only contact and the hub: it starts every task
in `triage` and routes it to an autonomous planner (`start_planning`; the user
approves the plan in chat via `approve_plan` or in the UI) or, when trivial or
design only, straight to execution (`start_work`). Every other agent runs
autonomously; its `report`s and `ask_orchestrator` questions are delivered to
the orchestrator as user messages. Roles live in `roles/*.md`, shared skills in `plugin/skills/`.
They stay project-agnostic; project knowledge comes from the target repo's
CLAUDE.md and skills.

## Conventions

- All server <-> web types live in `packages/shared/src/index.ts`. Change the
  wire protocol there first, then both sides.
- `ManagedSession` (`packages/server/src/session.ts`) is the only place that
  runs SDK queries. Keep SDK message handling there; the rest of the server only
  sees `TranscriptEntry` / `SessionSummary`. The one exception is
  `agentTools.ts`, which declares Steffe's in-process MCP tools; their
  behaviour lives in `TaskManager`.
- SDK types: verify against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  rather than from memory; the SDK moves fast.
- Smoke test a session change with a cheap model: `"model": "haiku"` and a
  trivial prompt against a scratch directory. For tasks, run the server with
  `STEFFE_FORCE_MODEL=haiku`, a different `PORT` and a scratch
  `STEFFE_DATA_DIR`, against a scratch git repo.
