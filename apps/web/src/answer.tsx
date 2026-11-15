import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import LatticeLoader from './reactbits/LatticeLoader.js';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { readPreference, savePreference } from './api.js';
import type { AnswerResult, Passage } from './api.js';
import { Icon } from './icons.js';

const TraceDrawer = lazy(() => import('./trace-drawer.js'));
const MarketCard = lazy(() => import('./market-card.js'));

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDate(value: string, timed = false) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : (timed ? timeFormat : dateFormat).format(date);
}

function sourceHref(value: string) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)) return url.href;
  } catch {
    return undefined;
  }
}

function Citation({ source }: { source: Passage }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const keyboard = useRef(false);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    above: boolean;
  }>();

  function reveal() {
    const bounds = button.current?.getBoundingClientRect();
    if (!bounds) return;
    const above =
      window.innerHeight - bounds.bottom < 310 &&
      bounds.top > window.innerHeight - bounds.bottom;
    setPosition({
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - 380)),
      top: above ? bounds.top - 8 : bounds.bottom + 8,
      above,
    });
  }

  function leave() {
    clearTimeout(timer.current);
    if (!pinned.current)
      timer.current = setTimeout(() => setPosition(undefined), 170);
  }

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!position) return;
    if (keyboard.current) {
      panel.current?.focus();
      keyboard.current = false;
    }
    function close(event: Event) {
      if (
        event.type === 'pointerdown' &&
        event.target instanceof Node &&
        (panel.current?.contains(event.target) ||
          button.current?.contains(event.target))
      )
        return;
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      pinned.current = false;
      setPosition(undefined);
      if (
        event instanceof KeyboardEvent &&
        panel.current?.contains(document.activeElement)
      ) {
        event.stopPropagation();
        button.current?.focus();
      }
    }
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('resize', close);
    };
  }, [position]);

  return (
    <span className="citation-wrap">
      <button
        ref={button}
        type="button"
        className="citation"
        aria-label={'Citation ' + source.id.slice(1) + ', ' + source.domain}
        aria-expanded={Boolean(position)}
        aria-controls={position ? id : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse' || pinned.current) return;
          clearTimeout(timer.current);
          timer.current = setTimeout(reveal, 160);
        }}
        onPointerLeave={leave}
        onClick={(event) => {
          clearTimeout(timer.current);
          if (pinned.current) {
            pinned.current = false;
            setPosition(undefined);
          } else {
            pinned.current = true;
            keyboard.current = event.detail === 0;
            reveal();
          }
        }}
      >
        {source.id.slice(1)}
      </button>
      {position &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="group"
            aria-label={'Supporting passage from ' + source.domain}
            tabIndex={-1}
            className={'passage-popover' + (position.above ? ' above' : '')}
            style={{ left: position.left, top: position.top }}
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={leave}
            onBlur={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget) ||
                event.relatedTarget === button.current
              )
                return;
              pinned.current = false;
              setPosition(undefined);
            }}
          >
            <div className="passage-domain">{source.domain}</div>
            <blockquote>{source.text}</blockquote>
            <dl>
              <div>
                <dt>Published</dt>
                <dd>
                  {source.publishedAt
                    ? formatDate(source.publishedAt)
                    : 'Date unavailable'}
                </dd>
              </div>
              <div>
                <dt>Retrieved</dt>
                <dd>{formatDate(source.retrievedAt, true)}</dd>
              </div>
            </dl>
            <a href={sourceHref(source.url)} target="_blank" rel="noreferrer">
              Open source <Icon name="external" />
            </a>
          </div>,
          document.body,
        )}
    </span>
  );
}

function decode(text: string) {
  return text
    .replace(/\\([\\`*_{}[\]#!|~:+-])/g, '$1')
    .replace(
      /&(amp|lt|gt);/g,
      (entity) =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>' })[entity] ?? entity,
    );
}

function inline(text: string, sources: Map<string, Passage>) {
  const nodes: ReactNode[] = [];
  const tokens =
    /\\.|(\[S[1-9]\d*\])|\*\*((?:\\.|[^*])+)\*\*|(`+)([^`]+)\3|(?<!\*)\*([^*]+)\*(?!\*)/g;
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    if (!match[1] && !match[2] && !match[4] && !match[5]) continue;
    const index = match.index;
    if (index > start) nodes.push(decode(text.slice(start, index)));
    if (match[1]) {
      const source = sources.get(match[1].slice(1, -1));
      nodes.push(source ? <Citation source={source} key={index} /> : match[1]);
    } else if (match[2]) {
      nodes.push(<strong key={index}>{inline(match[2], sources)}</strong>);
    } else if (match[4]) {
      nodes.push(<code key={index}>{match[4]}</code>);
    } else if (match[5]) {
      nodes.push(<em key={index}>{inline(match[5], sources)}</em>);
    }
    start = index + match[0].length;
  }
  if (start < text.length) nodes.push(decode(text.slice(start)));
  return nodes;
}

function CodeBlock({
  code,
  language,
}: {
  code: string;
  language: string | undefined;
}) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language || 'Code'}</span>
        <button
          type="button"
          className="quiet-button"
          aria-label="Copy code"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setFeedback('Copied');
            } catch {
              setFeedback('Could not copy');
            }
          }}
        >
          <Icon name={feedback === 'Copied' ? 'check' : 'copy'} />
          <span role="status">{feedback || 'Copy'}</span>
        </button>
      </div>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function Markdown({ text, passages }: { text: string; passages: Passage[] }) {
  const sources = new Map(passages.map((source) => [source.id, source]));
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  const list = /^(?:([-*+])|(\d+)[.)])\s+(.*)$/;
  const fence =
    /^ {0,3}(`{3,}(?!`)|~{3,}(?!~))[ \t]*([^\s`~]+)?(?:[ \t]+[^`]*)?$/;
  const heading = /^(#{1,6})\s+(.+)$/;
  const rule = /^(?:-{3,}|\*{3,}|_{3,})$/;
  const splitCells = (line: string) =>
    line
      .trim()
      .slice(1, -1)
      .split(/(?<!\\)(?:\\\\)*\|/)
      .map((cell) => cell.trim());
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? '';
    const start = index++;
    if (!line) continue;
    const opening = fence.exec(lines[start] ?? '');
    const title = heading.exec(line);
    if (opening?.[1]) {
      const marker = opening[1];
      const closing = new RegExp(
        '^ {0,3}' + marker[0] + '{' + marker.length + ',}[ \\t]*$',
      );
      const code: string[] = [];
      const indent = (lines[start] ?? '').match(/^ */)?.[0].length ?? 0;
      while (index < lines.length) {
        const next = lines[index++] ?? '';
        if (closing.test(next)) break;
        const spaces = next.match(/^ */)?.[0].length ?? 0;
        code.push(next.slice(Math.min(indent, spaces)));
      }
      blocks.push(
        <CodeBlock key={start} code={code.join('\n')} language={opening[2]} />,
      );
    } else if (title?.[1] && title[2]) {
      const Tag =
        (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[title[1].length - 1] ??
        'h6';
      blocks.push(
        <Tag key={start}>
          {inline(title[2].replace(/\s+#+$/, ''), sources)}
        </Tag>,
      );
    } else if (rule.test(line)) {
      blocks.push(<hr key={start} />);
    } else if (line.startsWith('|') && /^\|\s*:?-/.test(lines[index] ?? '')) {
      const headings = splitCells(line);
      const rows: string[][] = [];
      index++;
      while (lines[index]?.trim().startsWith('|'))
        rows.push(splitCells(lines[index++] ?? ''));
      blocks.push(
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Comparison table"
          key={start}
        >
          <table>
            <thead>
              <tr>
                {headings.map((cell, col) => (
                  <th key={col} scope="col">
                    {inline(cell, sources)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, col) => (
                    <td key={col}>{inline(cell, sources)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (list.test(line)) {
      const first = list.exec(line);
      const ordered = Boolean(first?.[2]);
      const entries = [first?.[3] ?? ''];
      for (;;) {
        const next = list.exec(lines[index]?.trim() ?? '');
        if (!next || Boolean(next[2]) !== ordered) break;
        entries.push(next[3] ?? '');
        index++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={start} {...(ordered ? { start: Number(first?.[2]) } : {})}>
          {entries.map((entry, row) => (
            <li key={row}>{inline(entry, sources)}</li>
          ))}
        </Tag>,
      );
    } else {
      const paragraph = [line];
      while (
        lines[index]?.trim() &&
        !fence.test(lines[index] ?? '') &&
        !heading.test(lines[index]?.trim() ?? '') &&
        !rule.test(lines[index]?.trim() ?? '') &&
        !list.test(lines[index]?.trim() ?? '') &&
        !lines[index]?.trim().startsWith('|')
      )
        paragraph.push(lines[index++]?.trim() ?? '');
      blocks.push(<p key={start}>{inline(paragraph.join(' '), sources)}</p>);
    }
  }
  return <div className="markdown">{blocks}</div>;
}

function SourceList({ passages }: { passages: Passage[] }) {
  const seen = new Set<string>();
  const sources = passages.filter((source) => {
    const url = sourceHref(source.url)?.split('#')[0] ?? source.url;
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  return (
    <details className="sources">
      <summary>
        Sources <span>{sources.length}</span>
      </summary>
      <ol>
        {sources.map((source) => (
          <li key={source.id}>
            <span className="source-number">{source.id.slice(1)}</span>
            <div>
              <a href={sourceHref(source.url)} target="_blank" rel="noreferrer">
                {source.title || source.domain} <Icon name="external" />
              </a>
              <span className="source-domain">{source.domain}</span>
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function Answer({
  text,
  passages,
  answer,
  requestId,
  provisional = false,
  note,
}: {
  text: string;
  passages: Passage[];
  answer?: AnswerResult;
  requestId?: string;
  provisional?: boolean;
  note?: string;
}) {
  const [copyState, setCopyState] = useState('');
  const [vote, setVote] = useState(
    () => requestId && readPreference('evidence:vote:' + requestId),
  );
  const [trace, setTrace] = useState(false);
  const traceButton = useRef<HTMLButtonElement>(null);
  const notices = [
    answer?.status === 'partial' ? 'Partial answer' : '',
    answer?.conflictingSources ? 'Sources disagree' : '',
  ].filter(Boolean);
  return (
    <article className="answer" aria-label="Answer">
      {answer?.status === 'abstained' && (
        <div className="progress">
          <LatticeLoader
            status="error"
            errorLabel="Answer unavailable"
            showTimer={false}
            pattern="rain"
            grid={4}
            cellSize={3}
            gap={1.5}
          />
        </div>
      )}
      {answer?.basis && (
        <p className="draft-label">
          {
            {
              attachments: 'Based on file excerpts · No web search',
              model: 'Model reply · No web search',
              calculation: 'Calculated from your inputs',
            }[answer.basis]
          }
        </p>
      )}
      {notices.length > 0 && (
        <p className="answer-notice">{notices.join(' · ')}</p>
      )}
      {note && !answer && <p className="answer-notice">{note}</p>}
      {provisional && <p className="draft-label">Checking this draft</p>}
      {answer?.marketQuote ? (
        <Suspense fallback={<Markdown text={text} passages={passages} />}>
          <MarketCard quote={answer.marketQuote} />
        </Suspense>
      ) : (
        <Markdown text={text} passages={passages} />
      )}
      {answer && passages.length > 0 && <SourceList passages={passages} />}
      {answer && answer.claims.length > 0 && (
        <details className="claims">
          <summary>
            Claim checks{' '}
            <span>
              {
                answer.claims.filter(({ verdict }) => verdict === 'supported')
                  .length
              }
              /{answer.claims.length} supported
              {answer.claims.some(({ verdict }) => verdict === 'unchecked') &&
                ` · ${answer.claims.filter(({ verdict }) => verdict === 'unchecked').length} unchecked`}
            </span>
          </summary>
          <ul>
            {answer.claims.map((claim, index) => (
              <li key={claim.id ?? index}>
                <strong className={'verdict ' + claim.verdict}>
                  {claim.verdict}
                </strong>
                <span>{claim.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {answer && (
        <div className="answer-actions">
          <button
            type="button"
            className="quiet-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopyState('Answer copied');
              } catch {
                setCopyState('Could not copy');
              }
            }}
          >
            <Icon name={copyState === 'Answer copied' ? 'check' : 'copy'} />
            {copyState || 'Copy'}
          </button>
          <span className="sr-only" role="status">
            {copyState}
          </span>
          {requestId && (
            <>
              {(['Helpful', 'Unhelpful'] as const).map((value) => (
                <button
                  type="button"
                  className="icon-button vote"
                  aria-label={value}
                  title={value}
                  aria-pressed={vote === value}
                  key={value}
                  onClick={() => {
                    const next = vote === value ? '' : value;
                    setVote(next);
                    savePreference('evidence:vote:' + requestId, next);
                  }}
                >
                  <Icon
                    name="thumb"
                    className={value === 'Unhelpful' ? 'thumb-down' : ''}
                  />
                </button>
              ))}
              <button
                type="button"
                className="quiet-button trace-button"
                ref={traceButton}
                onClick={() => setTrace(true)}
              >
                Trace
              </button>
            </>
          )}
        </div>
      )}
      {trace && requestId && (
        <Suspense fallback={<span role="status">Opening trace…</span>}>
          <TraceDrawer
            requestId={requestId}
            onClose={() => {
              setTrace(false);
              traceButton.current?.focus();
            }}
          />
        </Suspense>
      )}
    </article>
  );
}
