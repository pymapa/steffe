---
name: isolated-app-run
description: Start the project's app (dev server, API, ...) from your own worktree on your private $PORT without disturbing anything the user is running. Use whenever a Steffe agent needs to run the app to develop or test it.
---

# Running the app in isolation

You are a Steffe agent. The user may be running this project locally from
their main checkout for their own manual testing. That instance is off-limits:
don't connect to it, stop it, restart it or reuse its port.

1. **Find how to start the app.** Look in the project's CLAUDE.md and project
   skills first, then package.json scripts / Makefile / README.
2. **Use your port.** `$PORT` is reserved for you (and `$PORT+1` … `$PORT+9`
   for extra services). Pass it the way the project expects: the `PORT` env
   var, a `--port` flag (`vite --port $PORT --strictPort`), or a config
   override. If several services must talk to each other (web proxying to an
   API), give each its own port from your range and point them at each other.
   If the project hard-codes a port and offers no override, report that as a
   blocker rather than taking the default port.
   Pass the port explicitly on the command line (`PORT=$PORT npm run dev`,
   `--port $PORT`) rather than editing `.env` files: env-file loaders such
   as dotenv and `node --env-file` don't override a variable that is already
   set in the shell, so an `.env` value may be silently ignored, or a stale
   shell value used. After starting, check that the app really listens on
   your port (`lsof -nP -iTCP:$PORT -sTCP:LISTEN`) before you test against it.
3. **Run it in the background and record the PID**:
   `(<start command>) > /tmp/steffe-$PORT.log 2>&1 & echo $! > /tmp/steffe-$PORT.pid`
   Wait for readiness by polling (`curl -sf http://localhost:$PORT/...`) with a
   timeout, and read the log on failure.
4. **Clean up** when done: `kill $(cat /tmp/steffe-$PORT.pid)` and, if the
   start command spawned children, kill that process group or the specific
   child PIDs you found with `lsof -ti tcp:$PORT`. Never `pkill`/`killall` by
   name: other unrelated dev servers run on this machine.
