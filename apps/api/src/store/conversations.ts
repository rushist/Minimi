import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import {
  AnswerResultSchema,
  PassageSchema,
  type AnswerResult,
  type Passage,
} from '@chatagent/shared';
import { z } from 'zod';

export type Visibility = 'public' | 'private';
export interface SavedTurn {
  role: 'user' | 'assistant';
  content: string;
  visibility: Visibility;
  answer?: AnswerResult;
  sources?: Passage[];
  requestId?: string;
}
interface StoredTurn {
  role: SavedTurn['role'];
  content: string;
  visibility: Visibility;
  answer: string | null;
  sources: string | null;
  requestId: string | null;
}
interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  archived?: true;
}
export type StartConversation =
  | {
      ok: true;
      conversationId: string;
      summary: string;
      turns: { role: SavedTurn['role']; content: string }[];
    }
  | { ok: false; error: 'not_found' | 'busy' };

export interface ConversationStore {
  start(
    owner: string,
    conversationId: string | undefined,
    requestId: string,
    message: string,
  ): StartConversation;
  save(
    owner: string,
    conversationId: string,
    requestId: string,
    message: string,
    visibility: Visibility,
    answer: AnswerResult,
    sources: Passage[],
  ): boolean;
  cancel(owner: string, conversationId: string, requestId: string): void;
  list(owner: string, archived?: boolean): Conversation[];
  setArchived(
    owner: string,
    id: string,
    archived: boolean,
  ): 'ok' | 'busy' | 'not_found';
  remove(owner: string, id: string): 'ok' | 'busy' | 'not_found';
  get(
    owner: string,
    conversationId: string,
  ): (Conversation & { turns: SavedTurn[] }) | undefined;
}

const leaseMs = 60_000;
const historyWindow = 6;
const sourcesSchema = z.array(PassageSchema).max(24);
function decode<T extends z.ZodType>(
  value: string | null,
  schema: T,
): z.output<T> | undefined {
  if (!value) return;
  try {
    return schema.safeParse(JSON.parse(value)).data;
  } catch {
    return;
  }
}

export function openConversationStore(path: string, now = Date.now) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL, active_request TEXT, active_until INTEGER
    );
    CREATE INDEX IF NOT EXISTS conversations_owner_updated ON conversations (owner, updated_at DESC);
    CREATE TABLE IF NOT EXISTS chat_turns (
      seq INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, visibility TEXT NOT NULL, answer TEXT, sources TEXT
    );
    CREATE INDEX IF NOT EXISTS chat_turns_conversation_seq ON chat_turns (conversation_id, seq DESC);
  `);
  db.transaction(() => {
    const columns = db
      .prepare<[], { name: string }>('PRAGMA table_info(chat_turns)')
      .all();
    if (!columns.some(({ name }) => name === 'request_id'))
      db.exec('ALTER TABLE chat_turns ADD COLUMN request_id TEXT');
    const conversationColumns = db
      .prepare<[], { name: string }>('PRAGMA table_info(conversations)')
      .all();
    if (!conversationColumns.some(({ name }) => name === 'archived'))
      db.exec(
        'ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0',
      );
  }).immediate();
  const lookup = db.prepare<
    [string, string],
    Conversation & { summary: string }
  >(
    'SELECT id, title, updated_at AS updatedAt, summary FROM conversations WHERE owner = ? AND id = ?',
  );
  const acquire = db.prepare(`
    UPDATE conversations SET active_request = @requestId, active_until = @expires
    WHERE owner = @owner AND id = @id AND (active_request IS NULL OR active_until <= @now)
  `);
  const release = db.prepare(
    'UPDATE conversations SET active_request = NULL, active_until = NULL WHERE owner = ? AND id = ? AND active_request = ?',
  );
  const removeEmpty = db.prepare(`
    DELETE FROM conversations WHERE owner = ? AND id = ? AND active_request IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_turns WHERE conversation_id = conversations.id)
  `);
  const insertConversation = db.prepare(
    'INSERT INTO conversations (id, owner, title, updated_at) VALUES (?, ?, ?, ?)',
  );
  const insertTurn = db.prepare(
    'INSERT INTO chat_turns (conversation_id, role, content, visibility, answer, sources, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const publicTurns = db.prepare<
    [string, number, number],
    { role: SavedTurn['role']; content: string }
  >(
    "SELECT role, content FROM chat_turns WHERE conversation_id = ? AND visibility = 'public' ORDER BY seq DESC LIMIT ? OFFSET ?",
  );
  const recentTurns = db.prepare<[string], StoredTurn>(
    'SELECT role, content, visibility, answer, sources, request_id AS requestId FROM chat_turns WHERE conversation_id = ? ORDER BY seq DESC LIMIT 100',
  );
  const list = db.prepare<[string, number], Conversation>(`
    SELECT id, title, updated_at AS updatedAt FROM conversations
    WHERE owner = ? AND archived = ? AND EXISTS (SELECT 1 FROM chat_turns WHERE conversation_id = conversations.id)
    ORDER BY updated_at DESC, id LIMIT 50
  `);
  const updateArchived = db.prepare(`
    UPDATE conversations SET archived = ? WHERE owner = ? AND id = ?
      AND (active_request IS NULL OR active_until <= ?)
  `);
  const deleteConversation = db.prepare(`
    DELETE FROM conversations WHERE owner = ? AND id = ?
      AND (active_request IS NULL OR active_until <= ?)
  `);
  const manage = db.transaction(
    (owner: string, id: string, archived?: boolean) => {
      if (!lookup.get(owner, id)) return 'not_found' as const;
      const result =
        archived === undefined
          ? deleteConversation.run(owner, id, now())
          : updateArchived.run(Number(archived), owner, id, now());
      return result.changes ? ('ok' as const) : ('busy' as const);
    },
  );
  const start = db.transaction(
    (
      owner: string,
      conversationId: string | undefined,
      requestId: string,
      message: string,
    ): StartConversation => {
      const id = conversationId ?? randomUUID();
      const timestamp = now();
      if (!conversationId)
        insertConversation.run(
          id,
          owner,
          message.replace(/\s+/g, ' ').slice(0, 100),
          new Date(timestamp).toISOString(),
        );
      const conversation = lookup.get(owner, id);
      if (!conversation) return { ok: false, error: 'not_found' };
      if (
        !acquire.run({
          owner,
          id,
          requestId,
          now: timestamp,
          expires: timestamp + leaseMs,
        }).changes
      )
        return { ok: false, error: 'busy' };
      return {
        ok: true,
        conversationId: id,
        summary: conversation.summary,
        turns: publicTurns
          .all(id, historyWindow, 0)
          .reverse()
          .map(({ role, content }) => ({
            role,
            content: content.slice(0, 2000),
          })),
      };
    },
  );
  const save = db.transaction(
    (
      owner: string,
      id: string,
      requestId: string,
      message: string,
      visibility: Visibility,
      answer: AnswerResult,
      sources: Passage[],
    ) => {
      const conversation = lookup.get(owner, id);
      if (!conversation || !release.run(owner, id, requestId).changes)
        return false;
      insertTurn.run(id, 'user', message, visibility, null, null, null);
      insertTurn.run(
        id,
        'assistant',
        answer.markdown,
        visibility,
        JSON.stringify(answer),
        JSON.stringify(sources),
        requestId,
      );
      const aged =
        visibility === 'public'
          ? publicTurns.all(id, 2, historyWindow).reverse()
          : [];
      const summary = [
        conversation.summary,
        ...aged.map(
          ({ role, content }) =>
            role + ': ' + content.replace(/\s+/g, ' ').slice(0, 280),
        ),
      ]
        .filter(Boolean)
        .join('\n')
        .slice(-3000);
      db.prepare(
        'UPDATE conversations SET summary = ?, updated_at = ? WHERE owner = ? AND id = ?',
      ).run(summary, new Date(now()).toISOString(), owner, id);
      return true;
    },
  );
  const cancel = db.transaction(
    (owner: string, id: string, requestId: string) => {
      if (release.run(owner, id, requestId).changes) removeEmpty.run(owner, id);
    },
  );

  const store: ConversationStore = {
    start: (...args) => start.immediate(...args),
    save: (...args) => save.immediate(...args),
    cancel: (...args) => cancel.immediate(...args),
    list: (owner, archived = false) =>
      list
        .all(owner, Number(archived))
        .map((row) => (archived ? { ...row, archived: true } : row)),
    setArchived: (owner, id, archived) => manage.immediate(owner, id, archived),
    remove: (owner, id) => manage.immediate(owner, id),
    get(owner, id) {
      const conversation = lookup.get(owner, id);
      if (!conversation) return;
      const turns = recentTurns
        .all(id)
        .reverse()
        .map(
          ({
            role,
            content,
            visibility,
            answer,
            sources,
            requestId,
          }): SavedTurn => {
            const decodedAnswer = decode(answer, AnswerResultSchema);
            const decodedSources = decode(sources, sourcesSchema);
            return {
              role,
              content,
              visibility,
              ...(decodedAnswer ? { answer: decodedAnswer } : {}),
              ...(decodedSources ? { sources: decodedSources } : {}),
              ...(requestId ? { requestId } : {}),
            };
          },
        );
      return {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        turns,
      };
    },
  };
  return { store, close: () => db.close() };
}
