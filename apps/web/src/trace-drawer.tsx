import { useEffect, useRef, useState } from 'react';
import { readQuota, readTrace } from './api.js';
import type { Quota, TraceEvent } from './api.js';
import { Icon } from './icons.js';

export default function TraceDrawer({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [events, setEvents] = useState<TraceEvent[]>();
  const [quotas, setQuotas] = useState<Quota[]>();
  const [traceError, setTraceError] = useState(false);
  const [quotaError, setQuotaError] = useState(false);

  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    const signal = controller.signal;
    void readTrace(requestId, signal)
      .then(({ events }) => setEvents(events))
      .catch(() => {
        if (!signal.aborted) setTraceError(true);
      });
    void readQuota(signal)
      .then(({ quotas }) => setQuotas(quotas))
      .catch(() => {
        if (!signal.aborted) setQuotaError(true);
      });
    return () => controller.abort();
  }, [requestId]);

  const spans =
    events?.filter(({ durationMs }) => durationMs !== undefined) ?? [];
  const end = Math.max(0, ...spans.map(({ ts }) => Date.parse(ts)));
  const start = Math.min(
    end,
    ...spans.map(({ ts, durationMs }) => Date.parse(ts) - (durationMs ?? 0)),
  );
  const range = Math.max(end - start, 1);
  return (
    <dialog
      ref={dialog}
      className="trace-drawer"
      aria-labelledby="trace-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <section>
        <header>
          <h2 id="trace-title">Request trace</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close trace"
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" />
          </button>
        </header>
        <p className="request-id">{requestId}</p>
        <h3>Stage timings</h3>
        {traceError && <p>The trace could not be loaded.</p>}
        {!events && !traceError && <p role="status">Loading trace…</p>}
        {events && !spans.length && (
          <p>No timings recorded for this request.</p>
        )}
        {spans.length > 0 && (
          <ol className="waterfall">
            {spans.map(({ stage, ts, durationMs = 0, attrs }, index) => (
              <li key={index}>
                <div>
                  <strong>{stage}</strong>
                  <span>{Math.round(durationMs).toLocaleString()} ms</span>
                </div>
                <div className="waterfall-track" aria-hidden="true">
                  <span
                    style={{
                      marginLeft:
                        (100 * (Date.parse(ts) - durationMs - start)) / range +
                        '%',
                      width: (100 * durationMs) / range + '%',
                    }}
                  />
                </div>
                {(attrs.provider || attrs.fallback || attrs.error) && (
                  <small>
                    {[attrs.provider, attrs.fallback && 'Fallback', attrs.error]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                )}
              </li>
            ))}
          </ol>
        )}
        <h3>Cache activity</h3>
        {events && (
          <ul className="cache-activity">
            {events
              .filter(({ stage }) => stage === 'cache')
              .map(({ attrs }, index) => (
                <li key={index}>
                  {attrs.layer}: {attrs.cacheHit ? 'Hit' : 'Miss'}
                </li>
              ))}
            {!events.some(({ stage }) => stage === 'cache') && (
              <li>No lookups recorded</li>
            )}
          </ul>
        )}
        <h3>Provider quota</h3>
        {quotaError && <p>The quota could not be loaded.</p>}
        {!quotas && !quotaError && <p role="status">Loading quota…</p>}
        {quotas?.map(({ bucket, used, limit, nearLimit }) => (
          <div className="quota" key={bucket}>
            <div>
              <strong>{bucket}</strong>
              <span>
                {used.toLocaleString()}
                {limit !== null && ' / ' + limit.toLocaleString()}
                {nearLimit && ' · Near limit'}
              </span>
            </div>
            {limit !== null && limit > 0 && (
              <meter
                aria-label={bucket + ' quota used'}
                value={Math.min(used, limit)}
                max={limit}
              />
            )}
          </div>
        ))}
      </section>
    </dialog>
  );
}
