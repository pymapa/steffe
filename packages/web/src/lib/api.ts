import type {
  CreateProjectRequest,
  CreateSessionRequest,
  CreateTaskRequest,
  CatalogEntry,
  CreateCatalogEntryRequest,
  DeleteTaskResult,
  ProjectCatalog,
  SaveCatalogEntryRequest,
  PullRequestDetail,
  PullRequestListing,
  Task,
  TranscriptEntry,
  DirectoryListing,
  OpenProjectResult,
  Project,
  SessionDetail,
  SessionSummary,
  StoredSession,
} from '@steffe/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // projects
  listProjects: () => request<Project[]>('/api/projects'),
  openProject: (body: CreateProjectRequest) =>
    request<OpenProjectResult>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
  removeProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  analyzeSetup: (projectId: string) => request<SessionSummary>(`/api/projects/${projectId}/setup/analyze`, { method: 'POST' }),
  acceptSetup: (projectId: string) => request<Project>(`/api/projects/${projectId}/setup/accept`, { method: 'POST' }),
  dismissSetup: (projectId: string) => request<Project>(`/api/projects/${projectId}/setup/dismiss`, { method: 'POST' }),
  clearSetup: (projectId: string) => request<Project>(`/api/projects/${projectId}/setup`, { method: 'DELETE' }),
  listStoredSessions: (projectId: string) =>
    request<StoredSession[]>(`/api/projects/${projectId}/stored-sessions`),

  // sessions
  listSessions: () => request<SessionSummary[]>('/api/sessions'),
  getSession: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  createSession: (body: CreateSessionRequest) =>
    request<SessionSummary>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  sendMessage: (id: string, prompt: string) =>
    request<void>(`/api/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  interrupt: (id: string) => request<void>(`/api/sessions/${id}/interrupt`, { method: 'POST' }),
  close: (id: string) => request<void>(`/api/sessions/${id}`, { method: 'DELETE' }),
  resolvePermission: (requestId: string, allow: boolean) =>
    request<void>(`/api/permissions/${requestId}`, {
      method: 'POST',
      body: JSON.stringify({ allow }),
    }),

  // tasks
  createTask: (body: CreateTaskRequest) =>
    request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  approveTask: (id: string) => request<Task>(`/api/tasks/${id}/approve`, { method: 'POST' }),
  pauseTask: (id: string) => request<Task>(`/api/tasks/${id}/pause`, { method: 'POST' }),
  resumeTask: (id: string) => request<Task>(`/api/tasks/${id}/resume`, { method: 'POST' }),
  cancelTask: (id: string) => request<Task>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  handoffTask: (id: string) => request<Task>(`/api/tasks/${id}/handoff`, { method: 'POST' }),
  answerTask: (id: string, answer: string) =>
    request<Task>(`/api/tasks/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
  deleteTask: (id: string, deleteBranches: boolean) =>
    request<DeleteTaskResult>(`/api/tasks/${id}${deleteBranches ? '?branches=1' : ''}`, { method: 'DELETE' }),
  agentHistory: (taskId: string, name: string) =>
    request<TranscriptEntry[]>(`/api/tasks/${taskId}/agents/${encodeURIComponent(name)}/history`),
  getCatalog: (projectId: string) => request<ProjectCatalog>(`/api/projects/${projectId}/catalog`),
  createCatalogEntry: (projectId: string, body: CreateCatalogEntryRequest) =>
    request<CatalogEntry>(`/api/projects/${projectId}/catalog`, { method: 'POST', body: JSON.stringify(body) }),
  saveCatalogEntry: (projectId: string, body: SaveCatalogEntryRequest) =>
    request<CatalogEntry>(`/api/projects/${projectId}/catalog`, { method: 'PUT', body: JSON.stringify(body) }),
  getPullRequest: (projectId: string, number: number) =>
    request<PullRequestDetail>(`/api/projects/${projectId}/prs/${number}`),
  listPullRequests: (projectId: string) => request<PullRequestListing>(`/api/projects/${projectId}/prs`),

  // misc
  listDirs: (path: string, hidden = false) =>
    request<DirectoryListing>(`/api/fs/dirs?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`),
  defaults: () => request<{ browseRoot: string; models: string[] }>('/api/defaults'),
};
