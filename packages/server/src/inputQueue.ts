import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment } from '@steffe/shared';

type ContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number];

function attachmentBlock(a: Attachment): ContentBlock {
  if (a.mediaType === 'application/octet-stream') {
    // Saved to disk by storeFiles: the session opens it with its own tools.
    return {
      type: 'text',
      text: `<file name=${JSON.stringify(a.name)} path=${JSON.stringify(a.path)} />\nThe user attached this file. It is saved at that path; open it with your tools.`,
    };
  }
  if (a.mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.data }, title: a.name };
  }
  if (a.mediaType === 'text/plain') {
    // Inlined, so it reads the same whatever the file is (code, CSV, logs).
    const text = Buffer.from(a.data, 'base64').toString('utf8');
    return { type: 'text', text: `<file name=${JSON.stringify(a.name)}>\n${text}\n</file>` };
  }
  return { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } };
}

/**
 * A push-based AsyncIterable. The SDK's streaming-input mode pulls user turns
 * from an AsyncIterable; we need to push into it from HTTP handlers, and keep
 * it open (never return) until the session is closed.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(prompt: string, attachments: Attachment[] = []): void {
    if (this.closed) throw new Error('input queue is closed');
    const content: SDKUserMessage['message']['content'] = attachments.length
      ? [
          ...attachments.map(attachmentBlock),
          // The API rejects empty text blocks.
          ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
        ]
      : prompt;
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const queued = this.buffer.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
