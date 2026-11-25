import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import type {
  AnswerTaskRequest,
  TaskMessageRequest,
  DeleteTaskResult,
  CreateCatalogEntryRequest,
  SaveCatalogEntryRequest,
  CreateProjectRequest,
  OpenProjectResult,
  CreateTaskRequest,
  CreateSessionRequest,
  Attachment,
  SetAccountRequest,
  SetSandboxResourcesRequest,
  SetFlavorRequest,
  SendMessageRequest,
  SetModelRequest,
  ServerEvent,
} from '@steffe/shared';
import { SessionManager } from './sessionManager.js';
import { ProjectStore } from './projects.js';
import { listDirectories } from './fs.js';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { TaskManager, artifactsDir } from './tasks.js';
import { readHistory } from './session.js';
import { pruneAttachments, storeFiles } from './attachments.js';
import { getPullRequest, listGithubAccounts, listPullRequests, routeGh } from './github.js';
import { loadRoles } from './roles.js';
import { createCatalogEntry, loadCatalog, saveCatalogEntry } from './catalog.js';
import { findFreePort, isFreeEverywhere } from './ports.js';
import { ProjectSetupManager } from './projectSetup.js';
import { RetroManager } from './retro.js';
import { isGitRepo, routeGit } from './git.js';
import { Sandboxes, listFlavors, projectAt } from './isolagent.js';

const manager = new SessionManager();
const projects = new ProjectStore();
const sandboxes = new Sandboxes(projects, (event) => manager.broadcast(event));
routeGit((cwd) => sandboxes.gitRunner(cwd));
routeGh((cwd) => projectAt(projects, cwd)?.githubUser);
const tasks = new TaskManager(manager, projects, sandboxes);
const setup = new ProjectSetupManager(manager, projects, sandboxes);
const retros = new RetroManager(manager, projects, sandboxes, tasks);
// Every finished round gets a retro; STEFFE_RETRO=off leaves it to the button in the UI.
if (process.env.STEFFE_RETRO !== 'off') {
  tasks.onRoundFinished = (task) => {
    retros.run(task.id).catch((err) => console.error(`[steffe] the retro of "${task.title}" failed to start: ${String(err)}`));
  };
}
const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/defaults', (c) =>
  c.json({
    browseRoot: process.env.STEFFE_BROWSE_ROOT ?? homedir(),
    models: ['fable', 'opus', 'sonnet', 'haiku'],
  }),
);

// --- filesystem --------------------------------------------------------------

app.get('/api/fs/dirs', async (c) => {
  try {
    return c.json(await listDirectories(c.req.query('path'), c.req.query('hidden') === '1'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return c.json({ error: String(err) }, code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 500);
  }
});

// --- projects ----------------------------------------------------------------

app.get('/api/projects', (c) => c.json(projects.list()));

app.post('/api/projects', async (c) => {
  const body = (await c.req.json()) as CreateProjectRequest;
  if (!body.path) return c.json({ error: 'path is required' }, 400);
  try {
    const result = await projects.open(body);
    manager.broadcast({ type: 'project.updated', project: result.project });
    return c.json(result satisfies OpenProjectResult, result.created ? 201 : 200);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

const setupAction = (fn: (projectId: string) => Promise<unknown>) => async (c: import('hono').Context) => {
  try {
    return c.json(await fn(c.req.param('id')!));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, msg === 'project not found' ? 404 : 409);
  }
};

app.post('/api/projects/:id/setup/analyze', setupAction((id) => setup.analyze(id)));
app.post('/api/projects/:id/setup/accept', setupAction((id) => setup.accept(id)));
app.post('/api/projects/:id/setup/dismiss', setupAction((id) => setup.dismiss(id)));
app.delete('/api/projects/:id/setup', setupAction((id) => setup.clear(id)));
app.post('/api/projects/:id/setup/messages', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json()) as SendMessageRequest;
  try {
    const attachments = await receiveAttachments(body.attachments, id);
    if (!body.prompt && !attachments.length) return c.json({ error: 'prompt or an attachment is required' }, 400);
    return c.json(await setup.message(id, body.prompt ?? '', attachments));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, msg === 'project not found' ? 404 : 409);
  }
});

app.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  if (tasks.list().some((t) => t.projectId === id)) {
    return c.json({ error: 'delete the project\'s tasks first' }, 409);
  }
  setup.stop(id);
  for (const s of manager.list()) if (s.req.projectId === id) manager.remove(s.id);
  const gone = projects.get(id);
  if (gone?.isolagentFlavor) await sandboxes.forget(gone);
  if (!(await projects.remove(id))) return c.json({ error: 'not found' }, 404);
  manager.broadcast({ type: 'project.removed', projectId: id });
  return c.body(null, 204);
});

// --- isolagent sandbox ---------------------------------------------------------

app.get('/api/isolagent/flavors', async (c) => {
  const project = projects.get(c.req.query('projectId') ?? '');
  return c.json(await listFlavors(project?.path));
});

app.put('/api/projects/:id/sandbox', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const flavor = ((await c.req.json()) as SetFlavorRequest).flavor || null;
  const first = project.isolagentFlavor === undefined;
  if (flavor === project.isolagentFlavor) return c.json(project);
  // A live session keeps running where it was started, and its history stays there.
  const live = manager.list().some((s) => s.req.projectId === project.id && s.status !== 'ended' && s.status !== 'error');
  if (live) return c.json({ error: 'pause or finish the project\'s running sessions first' }, 409);
  if (project.isolagentFlavor) await sandboxes.forget(project);
  const updated = await projects.update(project.id, { isolagentFlavor: flavor });
  manager.broadcast({ type: 'project.updated', project: updated });
  manager.broadcast({ type: 'sandboxes.snapshot', sandboxes: sandboxes.list() });
  // A new project, now that it's known where its sessions run: propose how Steffe's roles should
  // use its agents and skills.
  if (first && !updated.setup && !updated.setupProposal && (await isGitRepo(updated.path))) {
    setup.analyze(updated.id).catch((err) => console.error(`[steffe] setup failed to start: ${String(err)}`));
  }
  return c.json(updated);
});

app.get('/api/github/accounts', async (c) => c.json({ accounts: await listGithubAccounts() }));

app.put('/api/projects/:id/account', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json()) as SetAccountRequest;
  const githubUser = body.githubUser?.trim() || null;
  const gitEmail = body.gitEmail?.trim() || null;
  if (githubUser === (project.githubUser ?? null) && gitEmail === (project.gitEmail ?? null)) return c.json(project);
  const updated = await projects.update(project.id, { githubUser, gitEmail });
  manager.broadcast({ type: 'project.updated', project: updated });
  // A sandbox reads the account when it starts. With nothing running in it, stop it now so the
  // next session starts it with the new one; otherwise the user restarts it.
  const live = manager.list().some((s) => s.req.projectId === project.id && s.status !== 'ended' && s.status !== 'error');
  if (updated.isolagentFlavor && !live) await sandboxes.stop(updated);
  return c.json(updated);
});

app.put('/api/projects/:id/sandbox/resources', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json()) as SetSandboxResourcesRequest;
  const whole = (v: number | null | undefined) => (v == null ? null : Number.isInteger(v) && v > 0 ? v : NaN);
  const sandboxCpus = whole(body.cpus);
  const sandboxMemMb = whole(body.memMb);
  if (Number.isNaN(sandboxCpus) || Number.isNaN(sandboxMemMb)) {
    return c.json({ error: 'CPUs and memory must be positive whole numbers' }, 400);
  }
  if (sandboxCpus === (project.sandboxCpus ?? null) && sandboxMemMb === (project.sandboxMemMb ?? null)) return c.json(project);
  const updated = await projects.update(project.id, { sandboxCpus, sandboxMemMb });
  manager.broadcast({ type: 'project.updated', project: updated });
  // A sandbox gets its size when it starts: as with the account, stop an unused one now.
  const live = manager.list().some((s) => s.req.projectId === project.id && s.status !== 'ended' && s.status !== 'error');
  if (updated.isolagentFlavor && !live) await sandboxes.stop(updated);
  return c.json(updated);
});

const sandboxAction = (fn: (project: import('@steffe/shared').Project, body: { hash?: string }) => Promise<unknown>) =>
  async (c: import('hono').Context) => {
    const project = projects.get(c.req.param('id')!);
    if (!project?.isolagentFlavor) return c.json({ error: 'the project has no sandbox' }, 404);
    try {
      await fn(project, c.req.header('content-type')?.includes('json') ? await c.req.json().catch(() => ({})) : {});
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  };

app.post('/api/projects/:id/sandbox/start', sandboxAction((p) => sandboxes.start(p)));
app.post('/api/projects/:id/sandbox/stop', sandboxAction((p) => sandboxes.stop(p, true)));
app.post('/api/projects/:id/sandbox/approve', sandboxAction((p, body) => sandboxes.approve(p, String(body.hash ?? ''))));

app.get('/api/projects/:id/stored-sessions', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await manager.storedSessions(project.path));
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

app.get('/api/projects/:id/prs', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  const listing = await listPullRequests(project.path, (branch) => tasks.taskForBranch(branch));
  // A task is named after its pull request, and follows when the PR is retitled.
  tasks.followPrs(listing.prs);
  return c.json(listing);
});

app.get('/api/projects/:id/catalog', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  return c.json(await loadCatalog(project.path));
});

app.post('/api/projects/:id/catalog', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await createCatalogEntry(project.path, (await c.req.json()) as CreateCatalogEntryRequest), 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.put('/api/projects/:id/catalog', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await saveCatalogEntry(project.path, (await c.req.json()) as SaveCatalogEntryRequest));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get('/api/projects/:id/prs/:number', async (c) => {
  const project = projects.get(c.req.param('id'));
  if (!project) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await getPullRequest(project.path, Number(c.req.param('number')), (b) => tasks.taskForBranch(b)));
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    return c.json({ error: (e.stderr || e.message).trim() }, 502);
  }
});

// --- tasks -------------------------------------------------------------------

const ATTACHMENT_TYPES = new Set<Attachment['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/octet-stream',
]);
/**
 * Base64 limits: the API's 5 MB per image; PDFs and text are kept well inside its request limit.
 * Other files go to disk, not to the API: 30 MB each.
 */
const MAX_BASE64: Record<string, number> = {
  'application/pdf': 20 * 1024 * 1024,
  'text/plain': 1024 * 1024,
  'application/octet-stream': 40 * 1024 * 1024,
};
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;

/** Validate message attachments. Images, PDFs and text are forwarded to the session as is; see receiveAttachments. */
function parseAttachments(raw: unknown): Attachment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('attachments must be an array');
  return raw.map((a: Partial<Attachment>, i) => {
    if (!a || !ATTACHMENT_TYPES.has(a.mediaType!)) throw new Error(`attachment ${i + 1}: unsupported type ${a?.mediaType}`);
    if (typeof a.data !== 'string' || !a.data) throw new Error(`attachment ${i + 1}: no data`);
    const max = MAX_BASE64[a.mediaType!] ?? MAX_IMAGE_BASE64;
    if (a.data.length > max) throw new Error(`attachment ${i + 1} is too large (max ${Math.round(max / 1024 / 1024)} MB)`);
    return { mediaType: a.mediaType!, data: a.data, name: String(a.name || `attachment ${i + 1}`).slice(0, 120) };
  });
}

/** Validated attachments of a message to a session of `projectId`, with the files that go to disk saved. */
const receiveAttachments = (raw: unknown, projectId: string): Promise<Attachment[]> =>
  storeFiles(projectId, parseAttachments(raw));

const taskAction =
  (fn: (id: string, body: unknown) => Promise<unknown>) =>
  async (c: import('hono').Context) => {
    try {
      const body = c.req.header('content-type')?.includes('json') ? await c.req.json().catch(() => ({})) : {};
      return c.json(await fn(c.req.param('id')!, body));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, msg === 'task not found' ? 404 : 409);
    }
  };

app.get('/api/tasks', (c) => c.json(tasks.list()));

app.get('/api/roles', async (c) => c.json([...(await loadRoles()).values()].map(({ prompt: _p, ...r }) => r)));

app.post('/api/tasks', async (c) => {
  const body = (await c.req.json()) as CreateTaskRequest;
  try {
    const parsed = parseAttachments(body.attachments);
    if (!body.projectId || (!body.prompt?.trim() && !parsed.length)) {
      return c.json({ error: 'projectId and a prompt or an attachment are required' }, 400);
    }
    if (!projects.get(body.projectId)) return c.json({ error: 'project not found' }, 400);
    const attachments = await storeFiles(body.projectId, parsed);
    const task = await tasks.create({ ...body, prompt: body.prompt?.trim() ?? '', attachments });
    const touched = await projects.touch(body.projectId);
    if (touched) manager.broadcast({ type: 'project.updated', project: touched });
    return c.json(task, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get('/api/tasks/:id', (c) => {
  const t = tasks.get(c.req.param('id'));
  return t ? c.json(t) : c.json({ error: 'not found' }, 404);
});

app.get('/api/tasks/:id/agents/:name/history', async (c) => {
  const task = tasks.get(c.req.param('id'));
  const agent = task?.agents.find((a) => a.name === c.req.param('name'));
  if (!task || !agent) return c.json({ error: 'not found' }, 404);
  if (!agent.claudeSessionId) return c.json([]);
  try {
    const configDir = await sandboxes.historyDir(projects.get(task.projectId), agent.claudeSessionId);
    return c.json(await readHistory(agent.claudeSessionId, agent.cwd, configDir));
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Screenshots agents hand over (e.g. a designer's mock), shown with the task's question.
app.get('/api/tasks/:id/artifacts/:name', async (c) => {
  const task = tasks.get(c.req.param('id'));
  const name = basename(c.req.param('name'));
  const type = IMAGE_TYPES[extname(name).toLowerCase()];
  if (!task || !type) return c.json({ error: 'not found' }, 404);
  try {
    const data = await readFile(join(artifactsDir(task), name));
    return c.body(data, 200, { 'content-type': type, 'cache-control': 'no-cache' });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

app.post('/api/tasks/:id/approve', taskAction((id) => tasks.approve(id)));
app.post('/api/tasks/:id/pause', taskAction((id) => tasks.pause(id)));
app.post('/api/tasks/:id/resume', taskAction((id) => tasks.resume(id)));
app.post('/api/tasks/:id/cancel', taskAction((id) => tasks.cancel(id)));
app.post('/api/tasks/:id/complete', taskAction((id) => tasks.complete(id)));
app.post('/api/tasks/:id/handoff', taskAction((id) => tasks.handoff(id)));
app.post(
  '/api/tasks/:id/message',
  taskAction(async (id, body) => {
    const req = body as TaskMessageRequest;
    const text = req.text?.trim() ?? '';
    const task = tasks.get(id);
    if (!task) throw new Error('task not found');
    const attachments = await receiveAttachments(req.attachments, task.projectId);
    if (!text && !attachments.length) throw new Error('text or an attachment is required');
    return tasks.message(id, text, attachments);
  }),
);
app.post(
  '/api/tasks/:id/answer',
  taskAction((id, body) => {
    const answer = (body as AnswerTaskRequest).answer?.trim();
    if (!answer) throw new Error('answer is required');
    return tasks.answer(id, answer);
  }),
);
app.post('/api/tasks/:id/retro', taskAction((id) => retros.run(id)));
app.get('/api/tasks/:id/retro', async (c) => {
  const record = await retros.forTask(c.req.param('id'));
  return record ? c.json(record) : c.json({ error: 'not found' }, 404);
});
// Every stored retro, oldest first (query `projectId` narrows it): the raw material for analysis across tasks.
app.get('/api/retros', async (c) => c.json(await retros.list(c.req.query('projectId'))));

app.delete('/api/tasks/:id', async (c) => {
  retros.stop(c.req.param('id'));
  const result = await tasks.remove(c.req.param('id'), { deleteBranches: c.req.query('branches') === '1' });
  return result ? c.json(result satisfies DeleteTaskResult) : c.json({ error: 'not found' }, 404);
});

// --- sessions ----------------------------------------------------------------

app.get('/api/sessions', (c) => c.json(manager.list().map((s) => s.summary())));

app.post('/api/sessions', async (c) => {
  const { attachments: rawAttachments, ...body } = (await c.req.json()) as CreateSessionRequest;
  const project = projects.get(body.projectId);
  if (!project) return c.json({ error: 'project not found' }, 404);
  let s;
  try {
    const attachments = await receiveAttachments(rawAttachments, project.id);
    const prompt = body.prompt?.trim() ?? '';
    if (!prompt && !attachments.length && !body.resumeSessionId) {
      return c.json({ error: 'a prompt, an attachment or a session to resume is required' }, 400);
    }
    const title = body.title || prompt.slice(0, 60).replace(/\s+/g, ' ') || attachments[0]?.name;
    // With attachments, the first message is sent after the start: the initial prompt can only be text.
    s = manager.create(
      { ...body, title, prompt: attachments.length ? '' : prompt },
      project.path,
      null,
      await sandboxes.session(project, body.resumeSessionId),
    );
    if (attachments.length) s.send(prompt, attachments);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
  const touched = await projects.touch(project.id);
  if (touched) manager.broadcast({ type: 'project.updated', project: touched });
  return c.json(s.summary(), 201);
});

app.get('/api/sessions/:id', (c) => {
  const s = manager.get(c.req.param('id'));
  return s ? c.json(s.detail()) : c.json({ error: 'not found' }, 404);
});

app.post('/api/sessions/:id/messages', async (c) => {
  const s = manager.get(c.req.param('id'));
  if (!s) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json()) as SendMessageRequest;
  try {
    const attachments = await receiveAttachments(body.attachments, s.req.projectId);
    if (!body.prompt && !attachments.length) return c.json({ error: 'prompt or an attachment is required' }, 400);
    s.send(body.prompt ?? '', attachments);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: String(err) }, 409);
  }
});

app.post('/api/sessions/:id/interrupt', async (c) => {
  const s = manager.get(c.req.param('id'));
  if (!s) return c.json({ error: 'not found' }, 404);
  await s.interrupt();
  return c.body(null, 204);
});

app.put('/api/sessions/:id/model', async (c) => {
  const s = manager.get(c.req.param('id'));
  if (!s) return c.json({ error: 'not found' }, 404);
  const { model } = (await c.req.json()) as SetModelRequest;
  try {
    await s.setModel(model || null);
    return c.body(null, 204);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
});

app.delete('/api/sessions/:id', (c) => {
  return manager.remove(c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
});

app.post('/api/permissions/:id', async (c) => {
  const { allow } = (await c.req.json()) as { allow: boolean };
  return manager.resolvePermission(c.req.param('id'), Boolean(allow))
    ? c.body(null, 204)
    : c.json({ error: 'no such pending permission' }, 404);
});

// --- HTTP + WebSocket ---------------------------------------------------------

void pruneAttachments();

const server = createServer(getRequestListener(app.fetch));
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const send = (event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  send({ type: 'projects.snapshot', projects: projects.list() });
  send({ type: 'sandboxes.snapshot', sandboxes: sandboxes.list() });
  send({ type: 'sessions.snapshot', sessions: manager.list().map((s) => s.summary()) });
  send({ type: 'tasks.snapshot', tasks: tasks.list() });
  for (const s of manager.list()) {
    for (const p of s.pendingPermissions.values()) send({ type: 'permission.requested', request: p.request });
  }
  const unsubscribe = manager.subscribe(send);
  ws.on('close', unsubscribe);
});

await projects.load();
await sandboxes.adopt();
await tasks.load();
void tasks.followStoredPrs();
// An explicit PORT (set by `npm run dev`, which also points the web proxy at
// it) is used as is; without one, take the first free port from 4010.
const PORT = process.env.PORT ? Number(process.env.PORT) : await findFreePort(4010);
if (!(await isFreeEverywhere(PORT))) {
  console.error(`steffe: port ${PORT} is already in use`);
  process.exit(1);
}
server.listen(PORT, () => {
  console.log(`steffe server listening on http://localhost:${PORT}`);
});

const shutdown = async () => {
  // Interrupt running agent turns first (bounded): their cost is only reported when a turn ends.
  await tasks.closeAll().catch(() => {});
  await tasks.flush().catch(() => {});
  manager.closeAll();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
