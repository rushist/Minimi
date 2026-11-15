import { memo, useEffect, useRef, useState } from 'react';
import { readAttachment, readConversation, streamChat } from './api.js';
import type { Attachment, Passage, Question, TraceEvent, Turn } from './api.js';
import { Answer } from './answer.js';
import { ComposerTools } from './composer-tools.js';
import { ChatBackdrop } from './chat-backdrop.js';
import { Icon } from './icons.js';
import LatticeLoader from './reactbits/LatticeLoader.js';
import PromptBar from './reactbits/PromptBar.js';
import ThoughtLine from './reactbits/ThoughtLine.js';

const steps: Record<string, string> = {
  planner: 'Planning',
  search: 'Searching the web',
  fetch: 'Reading sources',
  retrieval: 'Finding relevant passages',
  sufficiency: 'Reviewing evidence',
  synthesis: 'Writing the answer',
  verifier: 'Checking citations',
};

function stepLabel(event: TraceEvent) {
  if (event.type === 'planning') return steps.planner;
  if (event.type === 'researching') return steps.search;
  if (event.type === 'synthesis') return steps.synthesis;
  if (event.type === 'span_start') return steps[event.stage];
}

function Progress({
  stages,
  collapsed,
  status,
  elapsed,
}: {
  stages: string[];
  collapsed: boolean;
  status: 'working' | 'done' | 'error';
  elapsed?: number;
}) {
  const current = stages.at(-1) ?? 'Thinking';
  return (
    <div className="progress" data-stage={current}>
      <ThoughtLine
        label={current}
        doneLabel={
          status === 'error'
            ? 'Answer unavailable'
            : status === 'done'
              ? 'Done'
              : current
        }
        steps={stages}
        defaultOpen={false}
        working={status === 'working' && !collapsed}
        color="var(--ink)"
        shimmer
        {...(elapsed === undefined ? {} : { elapsed })}
        glyph={
          <LatticeLoader
            label=""
            pattern="rain"
            grid={4}
            showTimer={false}
            color="var(--accent)"
            cellSize={3}
            gap={1.5}
            glow={false}
            status={status}
            doneLabel=""
            errorLabel=""
          />
        }
      />
    </div>
  );
}

function SentPrompt({ text }: { text: string }) {
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 2000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('Prompt copied');
    } catch {
      setFeedback('Could not copy prompt');
    }
  }

  return (
    <section className="question-row" aria-label="Your question">
      <div className="question">{text}</div>
      <button
        type="button"
        className="icon-button question-copy"
        aria-label="Copy prompt"
        title="Copy prompt"
        onClick={copyPrompt}
      >
        <Icon name={feedback === 'Prompt copied' ? 'check' : 'copy'} />
      </button>
      <span
        className={
          feedback === 'Could not copy prompt'
            ? 'question-copy-error'
            : 'sr-only'
        }
        role="status"
      >
        {feedback}
      </span>
    </section>
  );
}

const SavedHistory = memo(function SavedHistory({ turns }: { turns: Turn[] }) {
  return turns.map((turn, index) =>
    turn.role === 'user' ? (
      <SentPrompt key={index} text={turn.content} />
    ) : (
      <Answer
        key={turn.requestId ?? index}
        text={turn.content}
        passages={turn.sources ?? []}
        {...(turn.answer ? { answer: turn.answer } : {})}
        {...(turn.requestId ? { requestId: turn.requestId } : {})}
      />
    ),
  );
});

interface Draft {
  question: Question;
  stages: string[];
  passages: Passage[];
  text: string;
  provisional: boolean;
  note?: string;
  error?: string;
}

export function Chat({
  initialId,
  ready,
  onSaved,
}: {
  initialId: string | undefined;
  ready: boolean;
  onSaved: (id: string, firstQuestion: string) => void;
}) {
  const [conversationId, setConversationId] = useState(initialId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>(
    initialId ? 'loading' : 'ready',
  );
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [message, setMessage] = useState('');
  const [webSearch, setWebSearch] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState('');
  const [reading, setReading] = useState(false);
  const upload = useRef<AbortController | undefined>(undefined);
  const [draft, setDraft] = useState<Draft>();
  const [settled, setSettled] = useState<{
    stages: string[];
    status: 'done' | 'error';
    elapsed: number;
  }>();
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const keepAtBottom = useRef(true);
  const active = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (!initialId) {
      if (matchMedia('(pointer: fine)').matches)
        input.current?.focus({ preventScroll: true });
      return;
    }
    const controller = new AbortController();
    void readConversation(initialId, controller.signal)
      .then(({ turns }) => {
        setTurns(turns);
        setLoadState('ready');
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadState('failed');
      });
    return () => controller.abort();
  }, [initialId, loadAttempt]);

  useEffect(
    () => () => {
      active.current?.abort();
      upload.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (keepAtBottom.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [draft, turns]);

  function stop() {
    active.current?.abort();
  }

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented && active.current)
        stop();
    }
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);

  async function send(question: Question) {
    if (
      !question.message ||
      active.current ||
      upload.current ||
      !ready ||
      loadState !== 'ready'
    )
      return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setAnnouncement('');
    keepAtBottom.current = true;
    setMessage('');
    setAttachments([]);
    setFileError('');
    let response: Draft = {
      question,
      stages: [],
      passages: [],
      text: '',
      provisional: false,
    };
    setDraft(response);
    setSettled(undefined);
    const started = performance.now();
    let frame: number | undefined;
    function update(patch: Partial<Draft>) {
      response = { ...response, ...patch };
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        if (!controller.signal.aborted) setDraft(response);
      });
    }
    try {
      const result = await streamChat(
        question,
        conversationId,
        controller.signal,
        (event) => {
          if (event.type === 'step') {
            const label = stepLabel(event.event);
            if (label && label !== response.stages.at(-1))
              update({ stages: [...response.stages, label] });
          } else if (event.type === 'sources') {
            update({ passages: event.passages });
          } else if (event.type === 'token') {
            update({
              text: response.text + event.text,
              provisional: response.provisional || Boolean(event.provisional),
            });
          } else if (event.type === 'partial' || event.type === 'abstain') {
            update({ note: event.reason });
          }
        },
      );
      if (controller.signal.aborted) return;
      setTurns((previous) => [
        ...previous,
        { role: 'user', content: question.message },
        {
          role: 'assistant',
          content: result.answer.markdown,
          answer: result.answer,
          sources: response.passages,
          requestId: result.requestId,
        },
      ]);
      setSettled({
        stages: response.stages,
        status: result.answer.status === 'abstained' ? 'error' : 'done',
        elapsed: (performance.now() - started) / 1000,
      });
      setDraft(undefined);
      setConversationId(result.id);
      setAnnouncement('Answer ready');
      onSaved(result.id, question.message);
    } catch (error) {
      if (controller.signal.aborted) {
        setDraft(undefined);
        setMessage((previous) => previous || question.message);
        setAttachments((previous) =>
          previous.length ? previous : question.attachments,
        );
        setAnnouncement('Response stopped');
      } else {
        setDraft({
          ...response,
          error:
            error instanceof Error
              ? error.message
              : 'Could not complete the request.',
        });
      }
    } finally {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (active.current === controller) {
        active.current = undefined;
        setBusy(false);
      }
    }
  }

  function submit(text: string) {
    if (reading) return;
    void send({
      message:
        text.trim() ||
        (attachments.length ? 'Summarize the attached files.' : ''),
      visibility: 'public',
      webSearch: webSearch ? 'auto' : 'off',
      allowHostedWithoutWeb: !webSearch,
      attachments,
    });
  }

  async function addFiles(files: File[]) {
    if (!files.length || upload.current) return;
    const controller = new AbortController();
    upload.current = controller;
    setReading(true);
    setFileError('');
    try {
      const added: Attachment[] = [];
      const errors: string[] = [];
      if (files.length > 3 - attachments.length)
        errors.push('Attach up to three files.');
      let remaining =
        6000 -
        attachments.reduce((length, file) => length + file.text.length, 0);
      for (const file of files.slice(0, 3 - attachments.length)) {
        if (!remaining) {
          errors.push('The excerpts already total 6,000 characters.');
          break;
        }
        try {
          const parsed = await readAttachment(file, controller.signal);
          const text = parsed.text.slice(0, remaining).trim();
          if (text) added.push({ ...parsed, text });
          remaining -= text.length;
        } catch (error) {
          if (controller.signal.aborted) return;
          errors.push(
            error instanceof Error ? error.message : 'Could not read the file.',
          );
        }
      }
      if (controller.signal.aborted) return;
      setAttachments((previous) => [...previous, ...added]);
      setFileError([...new Set(errors)].join(' '));
    } finally {
      upload.current = undefined;
      if (!controller.signal.aborted) setReading(false);
    }
  }

  const privacy = webSearch
    ? 'Your question is sent to the model. It can search the web when needed.'
    : 'Your question is sent to the model with web search disabled.';

  const empty = !turns.length && !draft && loadState === 'ready';
  const attachmentContent = (
    <>
      {attachments.length > 0 && (
        <ul className="attachments" aria-label="Attached files">
          {attachments.map((file, index) => (
            <li key={index}>
              <span>{file.name}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={'Remove ' + file.name}
                disabled={reading}
                onClick={() =>
                  setAttachments((files) =>
                    files.filter((_, item) => item !== index),
                  )
                }
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {attachments.length > 0 && (
        <p className="attachment-note">
          Up to 6,000 characters of file excerpts may be sent to the model.
        </p>
      )}
      {reading && (
        <p className="attachment-note" role="status">
          Reading files…
        </p>
      )}
      {fileError && (
        <p className="attachment-note" role="alert">
          {fileError}
        </p>
      )}
    </>
  );
  const composer = (
    <PromptBar
      className="composer"
      textareaRef={input}
      value={message}
      onValueChange={setMessage}
      onSend={submit}
      onStop={stop}
      busy={busy}
      disabled={reading || !ready || loadState !== 'ready'}
      allowEmpty={attachments.length > 0}
      placeholder="Ask a question…"
      sources={[]}
      commands={[]}
      models={[]}
      efforts={[]}
      radius={32}
      width={760}
      background="var(--surface)"
      menuBackground="var(--surface)"
      color="var(--ink)"
      attachmentContent={attachmentContent}
      tools={
        <ComposerTools
          webSearch={webSearch}
          setWebSearch={setWebSearch}
          onFiles={(files) => void addFiles(files)}
          reading={reading}
          empty={empty}
        />
      }
    />
  );

  return (
    <main className={'chat' + (empty ? ' chat-empty' : '')}>
      <ChatBackdrop visible={empty} />
      <div className="sr-only" role="status">
        {announcement}
      </div>
      {empty ? (
        <div className="welcome-heading">
          <h1>What do you wanna find out?</h1>
        </div>
      ) : (
        <>
          <div
            ref={viewport}
            className="thread-viewport"
            onScroll={(event) => {
              const element = event.currentTarget;
              keepAtBottom.current =
                element.scrollHeight -
                  element.clientHeight -
                  element.scrollTop <
                120;
            }}
          >
            <div className="thread">
              <h1 className="sr-only">Conversation</h1>
              {loadState === 'loading' && (
                <div className="loading" role="status">
                  <span>Loading conversation…</span>
                  <i />
                  <i />
                </div>
              )}
              {loadState === 'failed' && (
                <div className="load-error" role="alert">
                  Could not load this conversation.{' '}
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      setLoadState('loading');
                      setLoadAttempt((count) => count + 1);
                    }}
                  >
                    Retry
                  </button>
                </div>
              )}
              <SavedHistory turns={turns} />
              {settled?.status === 'done' && !draft && (
                <Progress
                  stages={settled.stages}
                  collapsed
                  status={settled.status}
                  elapsed={settled.elapsed}
                />
              )}
              {draft && (
                <>
                  <SentPrompt text={draft.question.message} />
                  {(draft.stages.length > 0 || draft.error) && (
                    <Progress
                      stages={draft.stages}
                      collapsed={Boolean(draft.text) && !draft.provisional}
                      status={draft.error ? 'error' : 'working'}
                    />
                  )}
                  {draft.text && (
                    <Answer
                      text={draft.text}
                      passages={draft.passages}
                      provisional={draft.provisional && !draft.error}
                      {...(draft.error ? { note: 'Interrupted reply' } : {})}
                      {...(!draft.error && draft.note
                        ? { note: draft.note }
                        : {})}
                    />
                  )}
                  {!draft.text && !draft.stages.length && !draft.error && (
                    <Progress
                      stages={['Starting research…']}
                      collapsed={false}
                      status="working"
                    />
                  )}
                  {draft.error && (
                    <div className="load-error" role="alert">
                      {draft.error}{' '}
                      <button
                        type="button"
                        className="quiet-button"
                        onClick={() => void send(draft.question)}
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
      <div className="composer-dock">
        {composer}
        <p className="privacy">{privacy}</p>
      </div>
    </main>
  );
}
