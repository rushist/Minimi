import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from './api.js';

afterEach(() => vi.unstubAllGlobals());

describe('chat streaming', () => {
  it('delivers each complete event while the connection is open and decodes split UTF-8', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
              },
            }),
            {
              headers: {
                'Content-Type': 'text/event-stream',
                'X-Conversation-Id': 'chat',
              },
            },
          ),
      ),
    );
    const received: string[] = [];
    let seen!: () => void;
    const firstEvent = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const result = streamChat(
      {
        message: 'Test',
        visibility: 'public',
        webSearch: 'auto',
        attachments: [],
      },
      undefined,
      new AbortController().signal,
      (event) => {
        if (event.type === 'token') {
          received.push(event.text);
          seen();
        }
      },
    );
    await Promise.resolve();
    const encoder = new TextEncoder();
    const frame = encoder.encode(
      'data: {"type":"token","text":"café"}\r\n\r\n',
    );
    const cut = frame.indexOf(0xc3) + 1;
    body.enqueue(encoder.encode(': keepalive\n\n'));
    body.enqueue(frame.slice(0, cut));
    expect(received).toEqual([]);
    body.enqueue(frame.slice(cut, -1));
    body.enqueue(frame.slice(-1));
    await firstEvent;
    expect(received).toEqual(['café']);
    body.enqueue(
      encoder.encode('data: {"type":"token","text":" au lait"}\n\n'),
    );
    body.enqueue(
      encoder.encode(
        'data: {"type":"done","requestId":"req","answer":{"markdown":"café au lait"}}\n\n',
      ),
    );
    body.close();
    await expect(result).resolves.toMatchObject({
      requestId: 'req',
      answer: { markdown: 'café au lait' },
    });
    expect(received).toEqual(['café', ' au lait']);
  });
});
