# Steffe through isolagent

## 1. Plan

A project picks an isolagent flavor; its sessions then run in that flavor's microVM. One sandbox
per project, started on first use.

The SDK's `spawnClaudeCodeProcess` option swaps the local `claude` for one inside the sandbox.
Steffe's MCP tools and permission checks go over the agent's stdin/stdout, so nothing else
changes:

```ts
spawnClaudeCodeProcess: ({ args, cwd, env, signal }) =>
  spawn('isolagent', ['exec', '--name', sandbox, '--no-tty', '--cwd', cwd,
                      ...envFlags(pick(env, FORWARDED)), '--', 'claude', ...args],
        { stdio: ['pipe', 'pipe', 'pipe'], signal }),
```

That `exec` doesn't exist yet: isolagent assumes a person in a terminal with one folder.

## 2. Changes in Steffe

Done, in `packages/server/src/isolagent.ts` and its callers. Tested only against a stand-in
script for the `isolagent` commands of section 3, which don't exist yet (`STEFFE_ISOLAGENT`
names the binary).

- `Project.isolagentFlavor`, picked on the project's Sandbox page (`isolagent flavors --json`).
- `Sandboxes`: `up` on first use, found again after a restart (`ps --json`), stopped by
  isolagent's idle timeout or from the UI. One stopped from the UI stays stopped
  (`Project.sandboxStopped`) until the user starts it there: meanwhile the project's sessions, git
  and ports are on the host, as without a flavor. A session resumed on the other side gets its
  transcript copied between the sandbox's config dir (`Project.sandboxStateDir`) and the host's. `Project.sandboxCpus` and
  `Project.sandboxMemMb` (Sandbox page) set `--cpus` and `--mem`; `STEFFE_SANDBOX_MEM` is the
  `--mem` of a project without its own.
- `ManagedSession` spawns Claude Code through `exec --no-tty`, forwarding only what the session
  adds to Steffe's own environment.
- All git of a sandboxed project runs in the sandbox (`routeGit`). On the host, a hook or
  config the agent planted would run outside the VM.
- Task folders moved to `worktrees/<projectId>/<taskId>/`, so one folder is shared. Tasks from
  before keep their folder and can't run in a sandbox.
- Ports: published per agent, and on close the app is stopped inside and the ports unpublished.
- Session history is read from the flavor's state folder.
- `Project.githubUser` and `Project.gitEmail`, also on the Sandbox page: `up` gets that gh login's
  token as `GH_TOKEN` and the email as `GIT_USER_EMAIL`, and Steffe's own `gh` uses the same login.
- UI: approve a changed `.isolagent.toml`, "image needs a build", and a warning when the image's
  Claude Code differs from the SDK's.

Not done:

- `gh` (PR list, create, close) still runs on the host, in the main checkout or a worktree.
- A flavor that isn't logged in shows up only as the session's own error.
- The Playwright MCP server needs `npx` and a browser in the image.

## 3. Changes in isolagent

Blockers:

1. **Headless exec**: `exec --no-tty [--name n] [--cwd p] [--env K=V]... -- cmd args`, on plain
   pipes, with the exit code. Today `exec` needs a terminal and only runs `zsh`. agentd merges
   stderr into stdout, which breaks the SDK's JSON stream: needs a `FrameStderr`.
2. **`up`**: start a sandbox with no terminal, detached, running until `down`. Today the VM stops
   when the first session ends. Also runs the image's entrypoint once (joined sessions skip it,
   and it copies CLAUDE.md and settings in).
3. **Approval without a prompt**: `up` fails with a distinct exit code and the diff instead of
   asking `Use it? [y/N]`; `isolagent approve --hash <sha>` records it.
4. **`--name`**: names are `<flavor>-<folder basename>` and a same-named start silently joins the
   running one. Every Steffe task worktree is called `task`.

To keep Steffe simple:

5. **Mount at the host path**, not `/work`: all of Steffe's paths are host paths.
6. **Shares at start**: `--share <dir>`, `--read-only <dir>`, `--git-dir <repo>/.git`. Shares are
   fixed at boot and worktrees are created later, so their parent folder is shared up front.

Small:

7. `flavors --json`, `ps --json`, `up --json` (with the state folder path).
8. `ports --rm`.
