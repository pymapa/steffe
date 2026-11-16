# Steffe roles

Each `*.md` file defines one agent role used by Steffe tasks. They are
project-agnostic: project-specific knowledge (how to run tests, start the app,
conventions) comes from the target repo's `CLAUDE.md` and `.claude/skills`,
which every agent loads.

Frontmatter:

| key               | meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `name`            | role id, used by `spawn_agent(role=...)`                              |
| `description`     | one line, shown to the orchestrator in its role list                  |
| `model`           | Required. A model alias (`fable`, `opus`, `sonnet`, `haiku`) or full id; roles never inherit |
| `tools`           | Steffe tools the role may call (comma separated)                   |
| `disallowedTools` | Claude Code tools removed for this role (comma separated)             |
| `mcp`             | extra MCP servers Steffe starts for the role (`playwright`)        |
| `writable`        | `cwd` (may edit its working directory) or `none`                      |
| `port`            | `true` to reserve a private port, exported as `PORT`                  |

The body is appended to Claude Code's default system prompt. Shared skills
live in `../plugin/skills` and are loaded into every agent as a local plugin.
