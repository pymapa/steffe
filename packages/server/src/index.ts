import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import type {
  AnswerTaskRequest,
  DeleteTaskResult,
  CreateCatalogEntryRequest,
  SaveCatalogEntryRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  CreateSessionRequest,
  SendMessageRequest,
  ServerEvent,
} from '@steffe/shared';
import { SessionManager } from './sessionManager.js';
import { ProjectStore } from './projects.js';
import { listDirectories } from './fs.js';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { TaskManager, artifactsDir } from './tasks.js';
import { readHistory } from './session.js';
import { getPullRequest, listPullRequests } from './github.js';
import { loadRoles } from './roles.js';
import { createCatalogEntry, loadCatalog, saveCatalogEntry } from './catalog.js';

const PORT = Number(process.env.PORT ?? 4010);
const manager = new SessionManager();
const projects = new ProjectStore();
const tasks = new TaskManager(manager, projects);
const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/defaults', (c) =>
  c.json({
    browseRoot: process.env.STEFFE_BROWSE_ROOT ?? homedir(),
    models: ['sonnet', 'opus', 'haiku'],
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
    const project = await projects.open(body);
    manager.broadcast({ type: 'project.updated', project });
    return c.json(project, 201);
  } catch (err) {
    return c.json({ error: String(err) }, 400);
  }
});

app.delete('/api/projects/:id', async (c) => {
  const id = c.req.param('id');
  if (tasks.list().some((t) => t.projectId === id)) {
    return c.json({ error: 'delete the project\'s tasks first' }, 409);
  }
  for (const s of manager.list()) if (s.req.projectId === id) manager.remove(s.id);
  if (!(await projects.remove(id))) return c.json({ error: 'not found' }, 404);
  manager.broadcast({ type: 'project.removed', projectId: id });
  return c.body(null, 204);
});

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
  return c.json(await listPullRequests(project.path, (branch) => tasks.taskForBranch(branch)));
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
  if (!body.projectId || !body.prompt?.trim()) return c.json({ error: 'projectId and prompt are required' }, 400);
  try {
    const task = await tasks.create(body);
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
  const agent = tasks.get(c.req.param('id'))?.agents.find((a) => a.name === c.req.param('name'));
  if (!agent) return c.json({ error: 'not found' }, 404);
  if (!agent.claudeSessionId) return c.json([]);
  try {
    return c.json(await readHistory(agent.claudeSessionId, agent.cwd));
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
    const data = await readFile(join(artifactsDir(task.id), name));
    return c.body(data, 200, { 'content-type': type, 'cache-control': 'no-cache' });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

app.post('/api/tasks/:id/approve', taskAction((id) => tasks.approve(id)));
app.post('/api/tasks/:id/pause', taskAction((id) => tasks.pause(id)));
app.post('/api/tasks/:id/resume', taskAction((id) => tasks.resume(id)));
app.post('/api/tasks/:id/cancel', taskAction((id) => tasks.cancel(id)));
app.post(
  '/api/tasks/:id/answer',
  taskAction((id, body) => {
    const answer = (body as AnswerTaskRequest).answer?.trim();
    if (!answer) throw new Error('answer is required');
    return tasks.answer(id, answer);
  }),
);
app.delete('/api/tasks/:id', async (c) => {
  const result = await tasks.remove(c.req.param('id'), { deleteBranches: c.req.query('branches') === '1' });
  return result ? c.json(result satisfies DeleteTaskResult) : c.json({ error: 'not found' }, 404);
});

// --- sessions ----------------------------------------------------------------

app.get('/api/sessions', (c) => c.json(manager.list().map((s) => s.summary())));

app.post('/api/sessions', async (c) => {
  const body = (await c.req.json()) as CreateSessionRequest;
  if (!body.projectId || !body.prompt) return c.json({ error: 'projectId and prompt are required' }, 400);
  const project = projects.get(body.projectId);
  if (!project) return c.json({ error: 'project not found' }, 404);
  const s = manager.create(body, project.path);
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
  if (!body.prompt) return c.json({ error: 'prompt is required' }, 400);
  try {
    s.send(body.prompt);
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

const server = createServer(getRequestListener(app.fetch));
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const send = (event: ServerEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  send({ type: 'projects.snapshot', projects: projects.list() });
  send({ type: 'sessions.snapshot', sessions: manager.list().map((s) => s.summary()) });
  send({ type: 'tasks.snapshot', tasks: tasks.list() });
  for (const s of manager.list()) {
    for (const p of s.pendingPermissions.values()) send({ type: 'permission.requested', request: p.request });
  }
  const unsubscribe = manager.subscribe(send);
  ws.on('close', unsubscribe);
});

await projects.load();
await tasks.load();
server.listen(PORT, () => {
  console.log(`steffe server listening on http://localhost:${PORT}`);
});

const shutdown = async () => {
  tasks.closeAll();
  await tasks.flush().catch(() => {});
  manager.closeAll();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
