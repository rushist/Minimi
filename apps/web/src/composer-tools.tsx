import { useEffect, useRef } from 'react';
import { Icon } from './icons.js';

export function ComposerTools({
  webSearch,
  setWebSearch,
  onFiles,
  reading,
  empty,
}: {
  webSearch: boolean;
  setWebSearch: (value: boolean) => void;
  onFiles: (files: File[]) => void;
  reading: boolean;
  empty: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const dropdown = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      const menu = dropdown.current;
      if (
        menu?.open &&
        event.target instanceof Node &&
        !menu.contains(event.target)
      )
        menu.open = false;
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  return (
    <>
      <input
        type="file"
        ref={picker}
        hidden
        accept=".pdf,.txt,.md,.csv,.json,.log"
        multiple
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <details
        className="composer-tools"
        data-placement={empty ? 'bottom' : 'top'}
        ref={dropdown}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && dropdown.current?.open) {
            dropdown.current.open = false;
            trigger.current?.focus();
          }
        }}
      >
        <summary ref={trigger} aria-label="Add files or change web search">
          <Icon name="add" />
        </summary>
        <div className="composer-tools-menu">
          <button
            type="button"
            disabled={reading}
            onClick={() => {
              if (dropdown.current) dropdown.current.open = false;
              trigger.current?.focus();
              picker.current?.click();
            }}
          >
            Add files or PDFs
          </button>
          <label>
            <input
              type="checkbox"
              checked={webSearch}
              onChange={(event) => setWebSearch(event.target.checked)}
            />
            Web search
          </label>
        </div>
      </details>
    </>
  );
}
