import type { Conversation } from './api.js';
import SwipeRow from './reactbits/SwipeRow.js';

export type HistoryAction = 'archive' | 'restore' | 'delete';

export function HistoryRow({
  chat,
  selected,
  open,
  pending,
  onOpen,
  onNavigate,
  onAction,
}: {
  chat: Conversation;
  selected: boolean;
  open: boolean;
  pending: boolean;
  onOpen: (open: boolean) => void;
  onNavigate: () => void;
  onAction: (action: HistoryAction) => void;
}) {
  const archiveAction = chat.archived ? 'restore' : 'archive';
  return (
    <SwipeRow
      className="history-swipe"
      label={chat.title}
      rowColor={selected ? 'var(--hover)' : 'var(--sidebar)'}
      textColor="var(--ink)"
      drawerColor="#586655"
      actionColor="#a64039"
      height={38}
      radius={5}
      actionWidth={57}
      fullSwipe={false}
      haptic={false}
      open={open}
      disabled={pending}
      onOpenChange={onOpen}
      actions={[
        {
          id: 'delete',
          label: 'Delete',
          dismiss: false,
          onSelect: () => onAction('delete'),
        },
        {
          id: archiveAction,
          label: chat.archived ? 'Restore' : 'Archive',
          dismiss: false,
          onSelect: () => onAction(archiveAction),
        },
      ]}
    >
      <button
        className="history-title"
        type="button"
        title={chat.title}
        aria-current={selected ? 'page' : undefined}
        onClick={onNavigate}
      >
        {chat.title}
      </button>
      <button
        className="history-actions"
        data-no-swipe
        type="button"
        aria-expanded={open}
        aria-label={'Actions for ' + chat.title}
        disabled={pending}
        onClick={() => onOpen(!open)}
      >
        ···
      </button>
    </SwipeRow>
  );
}
