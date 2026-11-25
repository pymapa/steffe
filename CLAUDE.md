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
memory) and tasks. A plain session's cwd is its project's path. The UI calls
plain sessions "free sessions" (`NewSession.tsx`): Claude Code without an
orchestrator, with a model the user picks and can switch between turns
(`ManagedSession.setModel`), and a stored session of the folder can be resumed.
Messages to any session can carry attachments (`Attachment`: images, PDFs, text
files), turned into content blocks in `inputQueue.ts`. Any other file (Office
documents, archives, text or PDFs too large to inline; up to 30 MB) is saved
under the project's worktrees folder (`attachments.ts`, `.attachments/`, pruned
after a month) and the session gets its path to open with its own tools.

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
local testing until the user clicks Handoff or asks the orchestrator for it
(`TaskManager.handoff`): the worktree is removed and the task branch checked
out in the main checkout. In triage the orchestrator can also take over an
existing open PR (`checkout_pr`, `Task.adoptedPr`): the PR's branch becomes
the task branch and the task goes straight to review, without a worktree. A
task with a PR is named after it, `#<number> <PR title>`, and so are its
agents' sessions (`TaskManager.followPr`; kept in step by the PR listing). Roles live in `roles/*.md`, shared skills in `plugin/skills/`.
They stay project-agnostic; project knowledge comes from the target repo's
CLAUDE.md and skills.

Project setup (`packages/server/src/projectSetup.ts`): when a git repo is first
opened, a `setup` agent (`roles/setup.md`, never spawned in tasks) reads the
repo's `.claude` agents, skills and tooling and proposes, per role, which of
them to use and how (`propose_setup`). The user discusses it in chat and
accepts it in the UI; it is stored on the project (`setup` in projects.json)
and each task agent gets its role's wiring appended to its system prompt.
The setup agent stays alive after Accept, and writes a suggested skill, agent
or CLAUDE.md note into the main checkout when the user asks it to (uncommitted).
The user can write to it at any later time (`ProjectSetupManager.message`): when
none is live, one is started that resumes the last conversation
(`setupSessionId`), or is told the setup in use when that is gone.

Retros (`packages/server/src/retro.ts`): when the orchestrator has finished a
round (`finish`, and every validator kept running past it has stopped), a
`facilitator` agent (`roles/facilitator.md`, started by Steffe, never spawned in
tasks, outside the agent limit) reads the agents' transcripts and Steffe's
numbers and stores what took long, what failed and what was redone
(`save_retro`). Records (`RetroRecord`) are JSON files in `~/.steffe/retros/`
and outlive their task; `GET /api/retros` returns them all. `STEFFE_RETRO=off`
leaves retros to the button on the task's Retro tab.

## Conventions

- All server <-> web types live in `packages/shared/src/index.ts`. Change the
  wire protocol there first, then both sides.
- `ManagedSession` (`packages/server/src/session.ts`) is the only place that
  runs SDK queries. Keep SDK message handling there; the rest of the server only
  sees `TranscriptEntry` / `SessionSummary`. The one exception is
  `agentTools.ts`, which declares Steffe's in-process MCP tools; their
  behaviour lives in `TaskManager` (`ProjectSetupManager` for `propose_setup`,
  `RetroManager` for `save_retro`).
- SDK types: verify against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  rather than from memory; the SDK moves fast.
- Smoke test a session change with a cheap model: `"model": "haiku"` and a
  trivial prompt against a scratch directory. For tasks, run the server with
  `STEFFE_FORCE_MODEL=haiku`, a different `PORT` and a scratch
  `STEFFE_DATA_DIR`, against a scratch git repo.
- A project with `isolagentFlavor` runs in an isolagent sandbox (`packages/server/src/isolagent.ts`,
  `docs/isolagent-integration.md`): its sessions, git and agent ports go through the `isolagent`
  CLI (`STEFFE_ISOLAGENT`), and paths inside are the same as on the host.
- A project's `githubUser` / `gitEmail` (Sandbox page) are the gh login and git author of its
  sandbox, passed to `isolagent up` as `GH_TOKEN` / `GIT_USER_EMAIL`; Steffe's own `gh` calls
  (`github.ts`) use the same login. Sessions on the host are not affected.
- A project's `sandboxCpus` / `sandboxMemMb` (Sandbox page) are its sandbox's `isolagent up`
  `--cpus` / `--mem`; unset leaves isolagent's defaults.
- At most `STEFFE_MAX_AGENTS` (default 4, 0 = no limit) task agents work at
  once across all tasks; further spawns are queued (`TaskAgent.state`
  `queued`) and started by `TaskManager.drain`.
- An agent that works `STEFFE_CHECKIN_MIN` minutes (default 30, 0 = off) on one
  assignment without reporting is announced to the orchestrator
  (`TaskManager.checkIns`), and again every that long.
