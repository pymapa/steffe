---
name: steffe-handoff
description: How to write a Steffe report (the report tool) so the orchestrator can act on it. Use before calling the steffe report tool.
---

# Writing a Steffe report

The orchestrator only sees your report, not your transcript. Make it complete
on its own and short enough to act on.

- **outcome**: `success` (done and verified), `failure` (validation found
  problems, or you couldn't make it work), `blocked` (something outside your
  control stops you, such as a missing credential, broken environment or
  unclear requirement).
- **summary** (markdown):
  - What you did or checked, one bullet per acceptance criterion where it
    applies.
  - Evidence: commands run and their results (test counts, errors), commits
    made (`git log --oneline`).
  - For failures: numbered, concrete findings with file:line and the fix you
    recommend.
  - Anything the next agent needs to know (ports used, env quirks, follow-ups).
  - **Friction**, when there was any: what slowed you down or broke along the
    way and wasn't part of the job itself (a command you had to guess, a slow
    or flaky test run, a brief that left something out, a tool that failed),
    one line each. The task's retro collects these; leave the section out
    when there was none.
