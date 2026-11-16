import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ImageAttachment } from '@steffe/shared';

/**
 * A push-based AsyncIterable. The SDK's streaming-input mode pulls user turns
 * from an AsyncIterable; we need to push into it from HTTP handlers, and keep
 * it open (never return) until the session is closed.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buffer: SDKUserMessage[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(prompt: string, images: ImageAttachment[] = []): void {
    if (this.closed) throw new Error('input queue is closed');
    const content: SDKUserMessage['message']['content'] = images.length
      ? [
          ...images.map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
          })),
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
