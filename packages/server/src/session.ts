import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  getSessionMessages,
  query,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CreateSessionRequest,
  ImageAttachment,
  PermissionRequest,
  ServerEvent,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  TranscriptEntry,
} from '@steffe/shared';
import { InputQueue } from './inputQueue.js';
import { assistantEntry, historyEntry, localUserEntry, systemEntry, userEntry } from './transcript.js';

export type Emit = (event: ServerEvent) => void;

/**
 * Extra configuration for sessions that run as an agent inside a Task.
 * Plain sessions (started from the UI) don't have one.
 */
export interface AgentSessionConfig {
  taskId: string;
  role: string;
  /** Appended to Claude Code's default system prompt. */
  systemPromptAppend: string;
  mcpServers?: Record<string, McpServerConfig>;
  disallowedTools?: string[];
  env?: Record<string, string>;
  /** Local plugin directories (Steffe's shared skills). */
  plugins?: string[];
  /**
   * Directories file-editing tools may write to. Anything else is denied.
   * Every other tool is auto-approved: task agents run unattended.
   */
  writableRoots: string[];
  /** Called whenever the agent finishes a turn (see lastAssistantText). */
  onTurnEnd?: (session: ManagedSession) => void;
  /** Called once when the query ends: closed, completed, or crashed (status 'error'). */
  onExit?: (session: ManagedSession) => void;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (r: PermissionResult) => void;
}

/**
 * One live Claude Code session: wraps a streaming-input `query()` and
 * projects its SDKMessage stream into transcript entries + status updates.
 */
export class ManagedSession {
  readonly id = randomUUID();
  readonly createdAt = new Date().toISOString();
  claudeSessionId: string | null;
  title: string;
  model: string | null;
  status: SessionStatus = 'starting';
  totalCostUsd = 0;
  numTurns = 0;
  lastError: string | null = null;
  updatedAt = this.createdAt;
  /** Text of the most recent assistant message, for agent turn-end handoffs. */
  lastAssistantText = '';

  readonly transcript: TranscriptEntry[] = [];
  readonly pendingPermissions = new Map<string, PendingPermission>();

  private readonly input = new InputQueue();
  private readonly abort = new AbortController();
  private q: Query | null = null;
  /** Entry id of the assistant message currently being streamed token-by-token. */
  private partialId: string | null = null;
  private partialText = '';

  constructor(
    readonly req: CreateSessionRequest,
    readonly cwd: string,
    private readonly emit: Emit,
    readonly agent: AgentSessionConfig | null = null,
  ) {
    this.claudeSessionId = req.resumeSessionId ?? null;
    this.title = req.title ?? req.prompt.slice(0, 60).replace(/\s+/g, ' ');
    this.model = req.model ?? null;
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      projectId: this.req.projectId,
      claudeSessionId: this.claudeSessionId,
      title: this.title,
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.req.permissionMode ?? 'default',
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      totalCostUsd: this.totalCostUsd,
      numTurns: this.numTurns,
      lastError: this.lastError,
      taskId: this.agent?.taskId ?? null,
      role: this.agent?.role ?? null,
    };
  }

  detail(): SessionDetail {
    return { ...this.summary(), transcript: this.transcript };
  }

  /** Spawn the query and start consuming its output in the background. */
  start(): void {
    if (this.req.resumeSessionId) void this.loadHistory(this.req.resumeSessionId);
    const a = this.agent;
    const options: Options = {
      cwd: this.cwd,
      model: this.req.model,
      permissionMode: this.req.permissionMode ?? 'default',
      resume: this.req.resumeSessionId,
      includePartialMessages: true,
      abortController: this.abort,
      // Load the user's and project's settings/CLAUDE.md just like the CLI does.
      settingSources: ['user', 'project', 'local'],
      systemPrompt: a
        ? { type: 'preset', preset: 'claude_code', append: a.systemPromptAppend }
        : { type: 'preset', preset: 'claude_code' },
      canUseTool: (toolName, input, { signal }) =>
        a ? Promise.resolve(this.agentPolicy(toolName, input)) : this.askPermission(toolName, input, signal),
      stderr: (data) => process.stderr.write(`[claude ${this.id.slice(0, 8)}] ${data}`),
    };
    if (a) {
      options.mcpServers = a.mcpServers;
      options.disallowedTools = a.disallowedTools;
      options.env = { ...process.env, ...a.env };
      options.plugins = a.plugins?.map((path) => ({ type: 'local' as const, path }));
    }
    this.q = query({ prompt: this.input, options });
    if (this.req.prompt) this.send(this.req.prompt);
    else this.setStatus('idle');
    void this.consume();
  }

  /** Images go straight to the SDK; the transcript only notes their names. */
  send(prompt: string, images: ImageAttachment[] = []): void {
    if (this.status === 'ended' || this.status === 'error') {
      throw new Error(`session is ${this.status}`);
    }
    const shown = [prompt, ...images.map((img) => `📎 ${img.name}`)].filter(Boolean).join('\n');
    this.addEntry(localUserEntry(randomUUID(), shown));
    this.input.push(prompt, images);
    this.setStatus('running');
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  close(): void {
    for (const p of this.pendingPermissions.values()) {
      p.resolve({ behavior: 'deny', message: 'session closed' });
    }
    this.pendingPermissions.clear();
    this.input.close();
    this.abort.abort();
    this.q?.close();
    if (this.status !== 'error') this.setStatus('ended');
  }

  resolvePermission(requestId: string, allow: boolean): boolean {
    const p = this.pendingPermissions.get(requestId);
    if (!p) return false;
    this.pendingPermissions.delete(requestId);
    p.resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'denied by user in Steffe' });
    this.emit({ type: 'permission.resolved', requestId, sessionId: this.id });
    return true;
  }

  /** Unattended permission policy for task agents: allow, except writes outside their roots. */
  private agentPolicy(toolName: string, input: Record<string, unknown>): PermissionResult {
    const a = this.agent!;
    if (EDIT_TOOLS.has(toolName)) {
      const target = String(input.file_path ?? input.notebook_path ?? '');
      const roots = [...a.writableRoots, tmpdir(), '/tmp', '/private/tmp'];
      if (target && roots.some((r) => isInside(r, resolve(this.cwd, target)))) return { behavior: 'allow' };
      return {
        behavior: 'deny',
        message: `Steffe: ${a.role} agents may only write inside ${a.writableRoots.join(', ') || '(nowhere)'}.`,
      };
    }
    if (toolName === 'AskUserQuestion') {
      return {
        behavior: 'deny',
        message:
          a.role === 'orchestrator'
            ? 'Ask in plain text in your reply while you are chatting with the user (triage, planning), or with ask_user while work runs.'
            : 'You run unattended. Ask the orchestrator with ask_orchestrator, or report blockers with report.',
      };
    }
    return { behavior: 'allow' };
  }

  private askPermission(toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const request: PermissionRequest = {
        id: randomUUID(),
        sessionId: this.id,
        toolName,
        input,
        createdAt: new Date().toISOString(),
      };
      this.pendingPermissions.set(request.id, { request, resolve });
      signal.addEventListener('abort', () => {
        if (this.pendingPermissions.delete(request.id)) {
          resolve({ behavior: 'deny', message: 'aborted' });
          this.emit({ type: 'permission.resolved', requestId: request.id, sessionId: this.id });
        }
      });
      this.emit({ type: 'permission.requested', request });
    });
  }

  /** Show the earlier conversation of a resumed session above anything new. */
  private async loadHistory(claudeSessionId: string): Promise<void> {
    try {
      const entries = await readHistory(claudeSessionId, this.cwd);
      if (entries.length === 0) return;
      entries.push(systemEntry(randomUUID(), 'Resumed session'));
      this.transcript.unshift(...entries);
      for (const entry of entries) this.emit({ type: 'session.entry', sessionId: this.id, entry });
      this.touch();
    } catch (err) {
      process.stderr.write(`[steffe] could not load history for ${claudeSessionId}: ${String(err)}\n`);
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.q!) this.handle(msg);
      if (this.status !== 'error') this.setStatus('ended');
    } catch (err) {
      if (this.abort.signal.aborted) {
        this.setStatus('ended');
      } else {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.addEntry(systemEntry(randomUUID(), `Session error: ${this.lastError}`));
        this.setStatus('error');
      }
    }
    this.agent?.onExit?.(this);
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.claudeSessionId = msg.session_id;
          this.model = msg.model;
          this.touch();
        }
        break;
      case 'stream_event': {
        const ev = msg.event;
        if (ev.type === 'message_start') {
          this.partialId = msg.uuid;
          this.partialText = '';
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.partialId) {
          this.partialText += ev.delta.text;
          this.emit({ type: 'session.partial', sessionId: this.id, entryId: this.partialId, text: this.partialText });
        }
        break;
      }
      case 'assistant': {
        const entry = assistantEntry(msg);
        // Clients render streamed text under the stream_event uuid; give the final
        // message the same id so it replaces the placeholder in place.
        if (entry && this.partialId) entry.id = this.partialId;
        this.partialId = null;
        const text = entry?.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
        if (text) this.lastAssistantText = text;
        if (entry) this.addEntry(entry);
        break;
      }
      case 'user': {
        // Tool results come back as synthetic user messages. Skip echoes of our own prompts.
        const entry = userEntry(msg, randomUUID());
        if (entry && entry.blocks.some((b) => b.type !== 'text')) this.addEntry(entry);
        break;
      }
      case 'result':
        this.totalCostUsd = msg.total_cost_usd;
        this.numTurns = msg.num_turns;
        if (msg.subtype !== 'success') {
          this.lastError = msg.errors.join('\n') || msg.subtype;
          this.addEntry(systemEntry(msg.uuid, `Turn ended with ${msg.subtype}: ${this.lastError}`));
        }
        this.partialId = null;
        this.setStatus('idle');
        this.agent?.onTurnEnd?.(this);
        break;
      default:
        break;
    }
  }

  private addEntry(entry: TranscriptEntry): void {
    this.transcript.push(entry);
    this.touch();
    this.emit({ type: 'session.entry', sessionId: this.id, entry });
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.touch();
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
    this.emit({ type: 'session.updated', session: this.summary() });
  }
}

/** Transcript of a stored (not live) Claude Code session, e.g. a closed task agent. */
export async function readHistory(claudeSessionId: string, cwd: string): Promise<TranscriptEntry[]> {
  const messages = await getSessionMessages(claudeSessionId, { dir: cwd });
  return messages.flatMap((m) => {
    const e = historyEntry(m);
    return e ? [e] : [];
  });
}
