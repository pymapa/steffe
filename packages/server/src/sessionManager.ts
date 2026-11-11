import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import type { CreateSessionRequest, ServerEvent, StoredSession } from '@steffe/shared';
import { ManagedSession, type AgentSessionConfig, type Emit } from './session.js';

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly listeners = new Set<Emit>();

  subscribe(fn: Emit): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit: Emit = (event: ServerEvent) => {
    for (const l of this.listeners) l(event);
  };

  /** Push an event to every connected client (used for non-session events too). */
  broadcast(event: ServerEvent): void {
    this.emit(event);
  }

  list(): ManagedSession[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  create(req: CreateSessionRequest, cwd: string, agent: AgentSessionConfig | null = null): ManagedSession {
    const s = new ManagedSession(req, cwd, this.emit, agent);
    this.sessions.set(s.id, s);
    this.emit({ type: 'session.updated', session: s.summary() });
    s.start();
    return s;
  }

  close(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.close();
    return true;
  }

  remove(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.close();
    this.sessions.delete(id);
    this.emit({ type: 'session.removed', sessionId: id });
    return true;
  }

  resolvePermission(requestId: string, allow: boolean): boolean {
    for (const s of this.sessions.values()) {
      if (s.resolvePermission(requestId, allow)) return true;
    }
    return false;
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
  }

  /** Sessions persisted by Claude Code on this machine for a given directory, for resuming. */
  async storedSessions(cwd: string, limit = 50): Promise<StoredSession[]> {
    const live = new Set(this.list().map((s) => s.claudeSessionId));
    const infos = await listSessions({ dir: cwd, limit });
    return infos
      .filter((i) => !live.has(i.sessionId))
      .map((i) => ({
        claudeSessionId: i.sessionId,
        cwd: i.cwd ?? '',
        firstPrompt: i.customTitle ?? i.firstPrompt ?? i.summary ?? '',
        updatedAt: new Date(i.lastModified).toISOString(),
      }));
  }
}
