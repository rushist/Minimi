import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { TraceEventSchema, type TraceEvent } from '@chatagent/shared';
import type { ArtifactKind } from './scope.js';

type Entry =
  | { kind: 'begin'; owner: string; requestId: string; ts: string }
  | { kind: 'event'; event: TraceEvent }
  | {
      kind: 'artifact';
      requestId: string;
      artifact: ArtifactKind;
      payload: string;
      truncated: boolean;
    };

export function openTraceStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_requests (
      request_id TEXT PRIMARY KEY, owner TEXT NOT NULL, ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trace_events (
      seq INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES trace_requests(request_id) ON DELETE CASCADE,
      stage TEXT NOT NULL, type TEXT NOT NULL, duration_ms REAL, attrs TEXT NOT NULL, event TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trace_events_request ON trace_events(request_id, seq);
    CREATE TABLE IF NOT EXISTS trace_artifacts (
      seq INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES trace_requests(request_id) ON DELETE CASCADE,
      kind TEXT NOT NULL, payload TEXT NOT NULL, truncated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trace_artifacts_request ON trace_artifacts(request_id, seq);
  `);
  const begin = db.prepare(
    'INSERT OR IGNORE INTO trace_requests VALUES (?, ?, ?)',
  );
  const event =
    db.prepare(`INSERT INTO trace_events (request_id, stage, type, duration_ms, attrs, event)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM trace_requests WHERE request_id = ?)`);
  const artifact =
    db.prepare(`INSERT INTO trace_artifacts (request_id, kind, payload, truncated)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM trace_requests WHERE request_id = ?)`);
  const write = db.transaction((batch: Entry[]) => {
    for (const row of batch) {
      if (row.kind === 'begin') begin.run(row.requestId, row.owner, row.ts);
      else if (row.kind === 'event') {
        const e = row.event;
        event.run(
          e.requestId,
          e.stage,
          e.type,
          e.durationMs ?? null,
          JSON.stringify(e.attrs),
          JSON.stringify(e),
          e.requestId,
        );
      } else
        artifact.run(
          row.requestId,
          row.artifact,
          row.payload,
          Number(row.truncated),
          row.requestId,
        );
    }
  });
  const owns = db.prepare(
    'SELECT 1 FROM trace_requests WHERE request_id = ? AND owner = ?',
  );
  const select = db.prepare<[string], { event: string }>(
    'SELECT event FROM trace_events WHERE request_id = ? ORDER BY seq',
  );
  const expire = db.prepare('DELETE FROM trace_requests WHERE ts < ?');
  const queue: Entry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastExpiry = 0;
  let closed = false;
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    if (queue.length) {
      const batch = queue.splice(0);
      try {
        write(batch);
      } catch {
        /* Trace storage must not interrupt the chat. */
      }
    }
    if (Date.now() - lastExpiry >= 3_600_000) {
      lastExpiry = Date.now();
      try {
        expire.run(new Date(lastExpiry - 7 * 86_400_000).toISOString());
      } catch {
        /* Retry on the next cleanup window. */
      }
    }
  }
  function enqueue(row: Entry) {
    if (closed || queue.length >= 1024) return;
    queue.push(row);
    if (!timer) {
      timer = setTimeout(flush, 150);
      timer.unref();
    }
  }
  return {
    enqueue,
    flush,
    read(owner: string, requestId: string) {
      if (!owns.get(requestId, owner)) return;
      return select
        .all(requestId)
        .map((row) => TraceEventSchema.parse(JSON.parse(row.event)));
    },
    artifacts(requestId: string) {
      return db
        .prepare(
          'SELECT kind, payload, truncated FROM trace_artifacts WHERE request_id = ? ORDER BY seq',
        )
        .all(requestId);
    },
    metrics() {
      return {
        latency: db
          .prepare(
            `WITH ranked AS (
          SELECT stage, duration_ms, ROW_NUMBER() OVER (PARTITION BY stage ORDER BY duration_ms) AS rn,
            COUNT(*) OVER (PARTITION BY stage) AS n
          FROM trace_events WHERE duration_ms IS NOT NULL AND type IN ('span', 'chat_finished')
        )
        SELECT stage, MAX(n) AS samples,
          MIN(CASE WHEN rn >= (n + 1) / 2 THEN duration_ms END) AS p50Ms,
          MIN(CASE WHEN rn >= (n * 95 + 99) / 100 THEN duration_ms END) AS p95Ms
        FROM ranked GROUP BY stage ORDER BY stage`,
          )
          .all(),
        cache: db
          .prepare(
            `SELECT json_extract(attrs,'$.layer') AS layer, COUNT(*) AS lookups,
          AVG(json_extract(attrs,'$.cacheHit')) AS hitRate
          FROM trace_events WHERE stage = 'cache' AND type = 'lookup' GROUP BY layer ORDER BY layer`,
          )
          .all(),
        credits: db
          .prepare(
            `SELECT r.request_id AS requestId,
          COALESCE(SUM(CASE WHEN e.stage = 'search' AND e.type = 'span' THEN json_extract(e.attrs,'$.credits') END), 0) AS credits
          FROM trace_requests r LEFT JOIN trace_events e ON e.request_id = r.request_id
          GROUP BY r.request_id ORDER BY r.ts DESC LIMIT 100`,
          )
          .all(),
      };
    },
    close() {
      if (!closed) {
        flush();
        closed = true;
        db.close();
      }
    },
  };
}

export type TraceStore = ReturnType<typeof openTraceStore>;
