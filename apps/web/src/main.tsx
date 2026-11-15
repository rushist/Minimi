import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { changeConversation, listConversations } from './api.js';
import type { Conversation } from './api.js';
import { Chat } from './chat.js';
import { Icon } from './icons.js';
import { HistoryRow, type HistoryAction } from './history-row.js';
import './reactbits.css';
import './styles.css';

function App() {
  const [mobile, setMobile] = useState(
    () => matchMedia('(max-width: 849px)').matches,
  );
  const [navOpen, setNavOpen] = useState(() => !mobile);
  const navToggle = useRef<HTMLButtonElement>(null);
  const navClose = useRef<HTMLButtonElement>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [ready, setReady] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [actionError, setActionError] = useState('');
  const [openRow, setOpenRow] = useState<string>();
  const [pending, setPending] = useState<string>();
  const pendingAction = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{ key: number; id?: string }>({ key: 0 });
  const [currentId, setCurrentId] = useState<string>();
  const activeId = useRef<string | undefined>(undefined);
  const title = conversations.find(({ id }) => id === currentId)?.title;

  useEffect(() => {
    const query = matchMedia('(max-width: 849px)');
    function resize(event: MediaQueryListEvent) {
      setMobile(event.matches);
      setNavOpen(!event.matches);
    }
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, []);

  useEffect(() => {
    if (mobile && navOpen) navClose.current?.focus();
  }, [mobile, navOpen]);

  function closeNav() {
    setNavOpen(false);
    requestAnimationFrame(() => navToggle.current?.focus());
  }

  useEffect(() => {
    const controller = new AbortController();
    void listConversations(controller.signal)
      .then(({ conversations }) => {
        setConversations(conversations);
        setHistoryError(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => controller.abort();
  }, [attempt]);

  function navigate(id?: string) {
    setView(({ key }) => ({ key: key + 1, ...(id ? { id } : {}) }));
    setCurrentId(id);
    activeId.current = id;
    setOpenRow(undefined);
    if (mobile && navOpen) closeNav();
  }

  async function manage(chat: Conversation, action: HistoryAction) {
    if (pendingAction.current) return;
    if (
      action === 'delete' &&
      !window.confirm('Delete this chat and its messages?')
    )
      return;
    pendingAction.current = true;
    setPending(chat.id);
    setActionError('');
    try {
      await changeConversation(chat.id, action);
      setConversations((items) =>
        items.flatMap((item) => {
          if (item.id !== chat.id) return [item];
          if (action === 'delete') return [];
          return [
            {
              id: item.id,
              title: item.title,
              updatedAt: item.updatedAt,
              ...(action === 'archive' ? { archived: true as const } : {}),
            },
          ];
        }),
      );
      if (activeId.current === chat.id && action === 'delete') navigate();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Could not update this chat.',
      );
    } finally {
      setOpenRow(undefined);
      setPending(undefined);
      pendingAction.current = false;
    }
  }

  const recent = conversations.filter((chat) => !chat.archived);
  const archived = conversations.filter((chat) => chat.archived);
  const row = (chat: Conversation) => (
    <HistoryRow
      key={chat.id}
      chat={chat}
      selected={chat.id === currentId}
      open={openRow === chat.id}
      pending={pending === chat.id}
      onOpen={(open) =>
        setOpenRow((current) =>
          open ? chat.id : current === chat.id ? undefined : current,
        )
      }
      onNavigate={() => {
        if (chat.id !== currentId) navigate(chat.id);
        else setOpenRow(undefined);
      }}
      onAction={(action) => void manage(chat, action)}
    />
  );

  return (
    <div className="app" data-nav={navOpen ? 'open' : 'closed'}>
      {mobile && (
        <button
          className="nav-backdrop"
          aria-hidden="true"
          tabIndex={-1}
          inert={!navOpen}
          onClick={closeNav}
        />
      )}
      <aside
        id="history"
        className="sidebar"
        aria-label="Conversation history"
        inert={!navOpen}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && mobile) {
            event.stopPropagation();
            closeNav();
          }
        }}
      >
        <div className="brand">
          <span className="brand-mark">
            <img src="/glint-sidebar.png" alt="Glint" />
          </span>
          {mobile && (
            <button
              ref={navClose}
              type="button"
              className="icon-button nav-close"
              aria-label="Close conversation list"
              onClick={closeNav}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
        <button type="button" className="new-chat" onClick={() => navigate()}>
          <Icon name="add" />
          New chat
        </button>
        <nav className="history" aria-label="Recent chats">
          <h2>History</h2>
          {!ready && <p role="status">Loading…</p>}
          {historyError && (
            <p>
              History unavailable{' '}
              <button
                className="quiet-button"
                onClick={() => setAttempt((count) => count + 1)}
              >
                Retry
              </button>
            </p>
          )}
          {ready && !historyError && !recent.length && (
            <p>No conversations yet</p>
          )}
          {actionError && <p role="alert">{actionError}</p>}
          {recent.map(row)}
          {archived.length > 0 && (
            <details className="archived-list">
              <summary>Archived ({archived.length})</summary>
              {archived.map(row)}
            </details>
          )}
        </nav>
      </aside>
      <div className="workspace" inert={mobile && navOpen}>
        <header className="topbar">
          <button
            ref={navToggle}
            type="button"
            className="icon-button"
            aria-label={
              navOpen ? 'Hide conversation list' : 'Show conversation list'
            }
            aria-expanded={navOpen}
            aria-controls="history"
            onClick={() => setNavOpen((open) => !open)}
          >
            <Icon name="panel" />
          </button>
          <span className="top-title">
            {title ?? (navOpen ? 'New chat' : 'Glint')}
          </span>
          {!navOpen && (
            <button
              type="button"
              className="icon-button top-add"
              aria-label="New chat"
              onClick={() => navigate()}
            >
              <Icon name="add" />
            </button>
          )}
        </header>
        <Chat
          key={view.key}
          initialId={view.id}
          ready={ready}
          onSaved={(id, firstQuestion) => {
            setCurrentId(id);
            activeId.current = id;
            setConversations((previous) => {
              const existing = previous.find(
                (conversation) => conversation.id === id,
              );
              return [
                {
                  id,
                  title:
                    existing?.title ??
                    firstQuestion.replace(/\s+/g, ' ').slice(0, 100),
                  updatedAt: new Date().toISOString(),
                  ...(existing?.archived ? { archived: true as const } : {}),
                },
                ...previous.filter((conversation) => conversation.id !== id),
              ];
            });
          }}
        />
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(<App />);
