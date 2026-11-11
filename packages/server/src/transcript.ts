import type { SDKAssistantMessage, SDKUserMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TranscriptBlock, TranscriptEntry } from '@steffe/shared';

/** Flatten Anthropic content blocks into the simplified UI shape. */
function toBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: TranscriptBlock[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: String(block.text ?? '') });
        break;
      case 'thinking':
        if (block.thinking) out.push({ type: 'thinking', text: String(block.thinking) });
        break;
      case 'tool_use':
        out.push({
          type: 'tool_use',
          id: String(block.id),
          name: String(block.name),
          input: block.input,
        });
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          toolUseId: String(block.tool_use_id),
          content: stringifyResult(block.content),
          isError: Boolean(block.is_error),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: Record<string, unknown>) => (c.type === 'text' ? String(c.text) : `[${String(c.type)}]`))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

export function assistantEntry(m: SDKAssistantMessage): TranscriptEntry | null {
  const blocks = toBlocks(m.message.content);
  if (blocks.length === 0) return null;
  return { id: m.uuid, role: 'assistant', blocks, timestamp: new Date().toISOString() };
}

export function userEntry(m: SDKUserMessage & { uuid?: string }, fallbackId: string): TranscriptEntry | null {
  const blocks = toBlocks(m.message.content);
  if (blocks.length === 0) return null;
  return { id: m.uuid ?? fallbackId, role: 'user', blocks, timestamp: new Date().toISOString() };
}

export function localUserEntry(id: string, prompt: string): TranscriptEntry {
  return { id, role: 'user', blocks: [{ type: 'text', text: prompt }], timestamp: new Date().toISOString() };
}

export function systemEntry(id: string, text: string): TranscriptEntry {
  return { id, role: 'system', blocks: [{ type: 'text', text }], timestamp: new Date().toISOString() };
}

/** A message read back from Claude Code's session store (for resumed sessions). */
export function historyEntry(m: SessionMessage): TranscriptEntry | null {
  if (m.parent_tool_use_id) return null; // inner subagent traffic
  const content = (m.message as { content?: unknown } | null)?.content;
  const blocks = toBlocks(content);
  if (blocks.length === 0) return null;
  return { id: m.uuid, role: m.type, blocks, timestamp: new Date().toISOString() };
}
