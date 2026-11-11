import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PermissionRequest,
  Project,
  ServerEvent,
  SessionSummary,
  Task,
  TranscriptEntry,
} from '@steffe/shared';
import { api } from './api';

export interface SteffeState {
  connected: boolean;
  projects: Project[];
  sessions: SessionSummary[];
  tasks: Task[];
  transcripts: Record<string, TranscriptEntry[]>;
  permissions: PermissionRequest[];
}

/**
 * Holds the live state mirrored from the server: session list, transcripts
 * for sessions we've opened, pending permission requests. Updated over WebSocket.
 */
export function useSteffe() {
  const [state, setState] = useState<SteffeState>({
    connected: false,
    projects: [],
    sessions: [],
    tasks: [],
    transcripts: {},
    permissions: [],
  });
  const loaded = useRef(new Set<string>());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        retry = 0;
        setState((s) => ({ ...s, connected: true }));
      };
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed) setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
      };
      ws.onmessage = (ev) => {
        const event = JSON.parse(ev.data) as ServerEvent;
        setState((s) => applyEvent(s, event));
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  /** Fetch the full transcript once for a session we haven't loaded yet. */
  const ensureTranscript = useCallback(async (sessionId: string) => {
    if (loaded.current.has(sessionId)) return;
    loaded.current.add(sessionId);
    try {
      const detail = await api.getSession(sessionId);
      setState((s) => ({
        ...s,
        transcripts: { ...s.transcripts, [sessionId]: detail.transcript },
      }));
    } catch {
      loaded.current.delete(sessionId);
    }
  }, []);

  return { state, ensureTranscript };
}

function applyEvent(s: SteffeState, e: ServerEvent): SteffeState {
  switch (e.type) {
    case 'projects.snapshot':
      return { ...s, projects: e.projects };
    case 'project.updated': {
      const rest = s.projects.filter((p) => p.id !== e.project.id);
      return { ...s, projects: [e.project, ...rest] };
    }
    case 'project.removed':
      return {
        ...s,
        projects: s.projects.filter((p) => p.id !== e.projectId),
        sessions: s.sessions.filter((x) => x.projectId !== e.projectId),
        tasks: s.tasks.filter((x) => x.projectId !== e.projectId),
      };
    case 'sessions.snapshot':
      return { ...s, sessions: e.sessions };
    case 'session.updated': {
      const idx = s.sessions.findIndex((x) => x.id === e.session.id);
      const sessions = idx === -1 ? [e.session, ...s.sessions] : s.sessions.slice();
      if (idx !== -1) sessions[idx] = e.session;
      return { ...s, sessions };
    }
    case 'session.removed':
      return {
        ...s,
        sessions: s.sessions.filter((x) => x.id !== e.sessionId),
        permissions: s.permissions.filter((p) => p.sessionId !== e.sessionId),
      };
    case 'session.entry': {
      const list = s.transcripts[e.sessionId];
      if (!list) return s; // not loaded; will be fetched on open
      const idx = list.findIndex((x) => x.id === e.entry.id);
      const next = list.slice();
      if (idx === -1) next.push(e.entry);
      else next[idx] = e.entry;
      return { ...s, transcripts: { ...s.transcripts, [e.sessionId]: next } };
    }
    case 'session.partial': {
      const list = s.transcripts[e.sessionId];
      if (!list) return s;
      const idx = list.findIndex((x) => x.id === e.entryId);
      const next = list.slice();
      if (idx === -1) {
        next.push({
          id: e.entryId,
          role: 'assistant',
          blocks: [{ type: 'text', text: e.text }],
          timestamp: new Date().toISOString(),
        });
      } else {
        next[idx] = { ...next[idx], blocks: [{ type: 'text', text: e.text }] };
      }
      return { ...s, transcripts: { ...s.transcripts, [e.sessionId]: next } };
    }
    case 'tasks.snapshot':
      return { ...s, tasks: e.tasks };
    case 'task.updated': {
      const idx = s.tasks.findIndex((x) => x.id === e.task.id);
      const tasks = idx === -1 ? [e.task, ...s.tasks] : s.tasks.slice();
      if (idx !== -1) tasks[idx] = e.task;
      return { ...s, tasks };
    }
    case 'task.removed':
      return { ...s, tasks: s.tasks.filter((x) => x.id !== e.taskId) };
    case 'permission.requested':
      return { ...s, permissions: [...s.permissions, e.request] };
    case 'permission.resolved':
      return { ...s, permissions: s.permissions.filter((p) => p.id !== e.requestId) };
    default:
      return s;
  }
}
