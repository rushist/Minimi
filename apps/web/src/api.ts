import type {
  AnswerResult,
  Passage,
  StreamEvent,
  TraceEvent,
} from '../../../packages/shared/src/index.js';

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  archived?: true;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
  answer?: AnswerResult;
  sources?: Passage[];
  requestId?: string;
}

export type WebSearch = 'off' | 'auto' | 'on';
export interface Attachment {
  name: string;
  text: string;
}
export interface Question {
  message: string;
  visibility: 'private' | 'public';
  webSearch: WebSearch;
  allowHostedWithoutWeb?: boolean;
  attachments: Attachment[];
}

export interface Quota {
  bucket: string;
  used: number;
  limit: number | null;
  period: string;
  nearLimit: boolean;
}

export type { AnswerResult, Passage, TraceEvent };

async function check(response: Response) {
  if (response.ok) return response;
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  throw new Error(
    payload?.error?.message ?? 'Could not reach the chat service.',
  );
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await check(
    await fetch('/api' + path, signal ? { signal } : {}),
  );
  return (await response.json()) as T;
}

export const listConversations = (signal?: AbortSignal) =>
  get<{ conversations: Conversation[] }>(
    '/conversations?includeArchived=true',
    signal,
  );
export async function changeConversation(
  id: string,
  action: 'archive' | 'restore' | 'delete',
) {
  await check(
    await fetch(
      '/api/conversations/' + encodeURIComponent(id),
      action === 'delete'
        ? { method: 'DELETE' }
        : {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ archived: action === 'archive' }),
          },
    ),
  );
}
export const readConversation = (id: string, signal: AbortSignal) =>
  get<Conversation & { turns: Turn[] }>(
    '/conversations/' + encodeURIComponent(id),
    signal,
  );
export const readTrace = (id: string, signal: AbortSignal) =>
  get<{ events: TraceEvent[] }>('/trace/' + encodeURIComponent(id), signal);
export const readQuota = (signal: AbortSignal) =>
  get<{ quotas: Quota[] }>('/quota', signal);

export async function readAttachment(
  file: File,
  signal: AbortSignal,
): Promise<Attachment> {
  const pdf = /\.pdf$/i.test(file.name);
  if (!pdf && !/\.(txt|md|csv|json|log)$/i.test(file.name))
    throw new Error(
      'Choose a PDF or a text file (.txt, .md, .csv, .json, .log).',
    );
  if (file.size > 5 * 1024 * 1024)
    throw new Error('Each file must be 5 MB or smaller.');
  const text = pdf
    ? (
        (await (
          await check(
            await fetch('/api/attachments/pdf', {
              method: 'POST',
              body: file,
              signal,
            }),
          )
        ).json()) as { text: string }
      ).text
    : await file.slice(0, 24000).text();
  const excerpt = text.trim().slice(0, 6000).trim();
  if (!excerpt) throw new Error('This file has no readable text.');
  return { name: file.name.slice(0, 160), text: excerpt };
}

export async function streamChat(
  question: Question,
  conversationId: string | undefined,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void,
) {
  const response = await check(
    await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...question, conversationId }),
      signal,
    }),
  );
  if (
    !response.body ||
    !response.headers.get('content-type')?.startsWith('text/event-stream')
  )
    throw new Error('The chat service did not return a response stream.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let failure: string | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      if (buffer.length > 2_000_000)
        throw new Error('The chat response was too large.');
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as StreamEvent;
        if (event.type === 'error') failure = event.message;
        if (event.type === 'done') {
          const id = response.headers.get('x-conversation-id');
          if (!event.answer || !id)
            throw new Error(failure ?? 'The chat finished without an answer.');
          return { id, requestId: event.requestId, answer: event.answer };
        }
        onEvent(event);
      }
    }
    throw new Error(
      failure ?? 'The connection closed before the answer was ready.',
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function readPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The controls still work when browser storage is unavailable.
  }
}
