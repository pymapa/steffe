# Steffe

Local web UI for spinning up and managing Claude Code sessions. Runs entirely on
your machine and drives Claude Code through the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), so it reuses your
existing `claude` login, settings, `CLAUDE.md` files, and permissions.

## Layout

```
roles/      Agent role definitions (planner, orchestrator, developer, ...)
plugin/     Shared skills loaded into every task agent
packages/
  shared/   Wire types shared by server and web (SessionSummary, ServerEvent, ...)
  server/   Node + Hono + ws. Owns live sessions via @anthropic-ai/claude-agent-sdk
  web/      Vite + React UI
```

## Run

```sh
npm install
npm run dev        # server on :4010, web on :3000 (proxies /api and /ws)
```

Open http://localhost:3000. If a port is taken, `npm run dev` moves to the next
free one and prints which it picked.

Auth: the SDK uses whatever credential Claude Code is configured with. If
`claude` works in your terminal, Steffe works too. `ANTHROPIC_API_KEY` in the
environment takes precedence if set.

Env vars: `PORT` (server port, default 4010), `STEFFE_WEB_PORT` (web port, default 3000), `STEFFE_BROWSE_ROOT` (where the
folder browser starts, default `$HOME`), `STEFFE_DATA_DIR` (where
`projects.json` lives, default `~/.steffe`). Steffe was called Conductor: while
`~/.conductor` exists it is used instead, because task worktrees and Claude
session history are tied to those paths. To switch, finish or delete the old
tasks, move `projects.json` to `~/.steffe`, and remove `~/.conductor`.

## Model

**Projects** are opened folders (usually git repos), persisted in
`~/.steffe/projects.json`. **Sessions** are live Claude Code conversations
and always belong to a project; the project's path is the session's working
directory. Open a project with the folder browser, then start sessions in it.

## How it works

- `POST /api/projects` records a folder as a project. `GET /api/fs/dirs` backs
  the folder browser in the UI.
- `POST /api/sessions` creates a `ManagedSession`, which calls the SDK's `query()`
  in streaming-input mode. User turns are pushed into an `InputQueue`
  (an AsyncIterable) so one query handles the whole conversation.
- SDK messages are projected into `TranscriptEntry` objects and broadcast to all
  browser clients over `/ws`. Partial text deltas are streamed as
  `session.partial` events while a turn is in flight.
- Tool permission prompts go through the SDK's `canUseTool` callback, which
  parks the request until the UI answers via `POST /api/permissions/:id`.
- `GET /api/projects/:id/stored-sessions` lists sessions Claude Code has
  persisted on disk for that folder (`listSessions()` from the SDK); pick one
  in the new-session form to resume it.

## Tasks

A **task** is one unit of work: a feature, fix or change. It runs as a team of
agents, and each agent is a full Claude Code session you can open and talk to.

```
triage ──start_planning──▶ planning ──approve──▶ executing ⇄ escalated ──▶ finishing ──▶ done
  │                         planner (autonomous)    ▲  orchestrator drives designer / developer / reviewer / tester
  └──────start_work (trivial, or design only)───────┘
```

The **orchestrator** is your only contact: it starts every task, and you talk
to it throughout. Every other agent (planner included) runs autonomously and
asks the orchestrator when it needs something (`ask_orchestrator`); the
orchestrator answers, or asks you first in the chat.

Each session (task) shows one status in the sidebar and its header: **New**
(the orchestrator is sizing it up), **Working** (agents are busy; nothing is
needed from you), **Ready for handoff** (your turn: a reply, a plan or design
to approve, a question, or a finished result) or **Paused** (resume to
continue). The detail next to it says what's waiting.

0. **Triage.** Steffe starts the orchestrator with your request in the
   project's main checkout, read only. It reads the relevant code (and may ask
   you a quick question) to size the work, then picks a route:
   - **Question** ("what is in X", "how does Y work"): it answers in chat. No
     branch or worktree is created.

   Every other route creates the branch `steffe/<slug>-<id>` in its own
   worktree under `~/.steffe/worktrees/<task>/task` first:
   - **Design only** ("just the design"): `start_work` with one design item,
     and a designer starts right away. After you approve the design, the
     orchestrator asks whether to build it now (`add_items` adds the code
     items) or stop; a design-only task finishes without a PR.
   - **Trivial** (unambiguous, small and local, no design decisions):
     `start_work` sets a small plan, usually one item, and goes straight to
     executing, with no planner and no approval step.
   - **Anything else**: `start_planning` starts an autonomous planner with
     the request and the orchestrator's notes.
1. **Planning.** The **planner** explores the repo (and, for UI changes,
   looks at the app through Playwright on its own port) and keeps a
   structured plan on the board through `update_plan`: a spec, plus work items
   with acceptance criteria, dependencies, `worktree`/`shared` mode and
   validators. Its questions reach you through the orchestrator. When the plan
   is ready, the orchestrator presents it in the chat: approve it there
   (`approve_plan`), ask for changes, or click **Approve plan**.
2. **Executing.** The approved plan goes back to the orchestrator, which now runs unattended. It
   uses Steffe tools (`spawn_agent`, `message_agent`, `update_item`,
   `merge_item`, `ask_user`, `finish`, ...) and never writes code itself.
   Agents finish an assignment with `report`, and Steffe delivers each
   report to the orchestrator as a new message. This hub is the only channel
   between agents.
   - A **developer** on a `worktree` item gets its own branch and worktree off
     the task branch, and must commit its work. When its brief doesn't settle a
     decision, it calls `ask_orchestrator` and waits. The orchestrator knows
     the whole plan and answers with `message_agent`, after asking you
     (`ask_user`) if only you can decide.
   - A **reviewer** (read-only) checks code and tests against the acceptance
     criteria. It runs once, on the task branch after every item is merged;
     its findings go back to each item's developer, and fixes are merged again.
   - A **tester** runs the app and checks it with Playwright MCP (isolated,
     headless browser).
   - A **designer** (Fable) handles `design` items, which the planner adds
     when you want to see a mock before development (or the orchestrator, for
     a trivial task you asked a mock for). It mocks the change up in the
     project's real UI with fake data on its own branch and screenshots it.
     The orchestrator hands you the screenshots in the task view: **Approve
     design**, or describe tweaks and the designer revises. Ask for a live
     mock and the designer also leaves the app running on its private port,
     with an **Open mock** link to the page (Steffe stops that app when the
     designer is closed). Code items that
     depend on the design start after approval. Design items are never
     merged, the designer marks every mock change `STEFFE-MOCK`, and
     `finish` refuses to open the PR while any line the task adds carries
     that marker, so the mock UI cannot ship.
   - Failed validation goes back to the developer. After 3 failures the item
     is blocked and the orchestrator has to `ask_user`. Questions show up as a
     banner in the task view.
3. **Finishing.** `finish` checks that every item is merged and the tree is
   clean. It then pushes the branch and opens a PR with `gh`; the
   orchestrator's report becomes the PR description. The report is also saved
   to `~/.steffe/tasks/<id>.report.md`. Item worktrees are removed. The
   task worktree is kept, so you can test the branch locally.

**Isolation.** Agents never touch your main checkout or anything you have
running from it. Each developer or tester gets a private port (from 41000,
spaced 10 apart), exported as `PORT`. The shared `isolated-app-run` skill
tells them how to start the app on it and how to clean up. Task agents run
unattended: Steffe auto-approves their tool calls but denies file edits
outside their own worktree. Bash is not sandboxed.

**Persistence.** Tasks are saved to `~/.steffe/tasks/<id>.json`. After a
server restart, any task that was in flight shows as *paused*. **Resume**
brings its agents back with SDK `resume`, shows their earlier transcripts, and
tells the ones that were mid-assignment to continue.

**Roles and skills** are project-agnostic and live in this repo:
`roles/*.md` (frontmatter: model, Steffe tools, disallowed tools, MCP
servers, writable, port; see `roles/README.md`) and `plugin/skills/`, which is
loaded into every agent as a local plugin. Role files are re-read for each new
agent, so edits apply without a restart. Project-specific knowledge comes from
the target repo's `CLAUDE.md` and `.claude/skills`.

**Agents and skills** appear in the left column of each project. Each is split
into *Project* (`<repo>/.claude/agents/*.md`, `<repo>/.claude/skills/*/SKILL.md`)
and *Steffe* (`roles/`, `plugin/skills/`). Open one to read its instructions
and frontmatter, or edit the file in place. **+ New** creates either kind from
a template.

**Pull requests.** Each project has a *Pull requests* view. It lists open PRs
and recent `steffe/*` PRs with their state (open, draft, merged, closed),
CI status, review decision and merge conflicts, and links back to the task
that opened each one. It uses `gh` and refreshes every minute.

Set `STEFFE_FORCE_MODEL=haiku` to run every role on a cheap model for smoke
tests. `STEFFE_AGENT_PORT_BASE` moves the agent port range.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/projects` | Opened projects |
| POST | `/api/projects` | Open a folder (`path`, `name?`) |
| DELETE | `/api/projects/:id` | Forget a project (closes its sessions; files untouched) |
| GET | `/api/projects/:id/stored-sessions` | Resumable Claude Code sessions in that folder |
| GET | `/api/fs/dirs?path=` | Subdirectories, for the folder browser |
| GET | `/api/sessions` | Live sessions |
| POST | `/api/sessions` | Create (`projectId`, `prompt`, `model?`, `permissionMode?`, `resumeSessionId?`) |
| GET | `/api/sessions/:id` | Session + transcript |
| POST | `/api/sessions/:id/messages` | Send the next user turn |
| POST | `/api/sessions/:id/interrupt` | Interrupt the current turn |
| DELETE | `/api/sessions/:id` | Close and forget |
| POST | `/api/permissions/:id` | `{ allow: boolean }` |
| GET | `/api/projects/:id/prs` | Pull requests with state / CI / review (`gh`) |
| GET | `/api/roles` | Role definitions from `roles/` |
| GET | `/api/projects/:id/catalog` | Steffe + project agents and skills |
| POST | `/api/projects/:id/catalog` | Create an agent/skill from a template (`kind`, `source`, `name`, `description`) |
| PUT | `/api/projects/:id/catalog` | Save an edited agent/skill file (`kind`, `source`, `name`, `raw`) |
| GET | `/api/projects/:id/prs/:number` | One PR with description, checks, reviews, commits, files |
| GET | `/api/tasks` | All tasks |
| POST | `/api/tasks` | Create (`projectId`, `prompt`, `title?`, `model?`); starts the orchestrator in triage |
| GET | `/api/tasks/:id` | One task |
| POST | `/api/tasks/:id/approve` | Approve the planner's plan; the orchestrator executes it |
| POST | `/api/tasks/:id/answer` | `{ answer }` to the orchestrator's pending question |
| POST | `/api/tasks/:id/pause` · `/resume` · `/cancel` | Lifecycle |
| DELETE | `/api/tasks/:id` | Forget a task and remove its worktrees (branches kept) |
| WS | `/ws` | `ServerEvent` stream (see `packages/shared/src/index.ts`) |

## Not yet done

- Projects and tasks persist. Plain (non-task) sessions exist only in server
  memory; after a restart they can still be resumed from the stored-session
  list.
- Single-user, no auth on the HTTP API. Bind to localhost only.
- No markdown rendering, no image input, no "always allow" permission rules.
