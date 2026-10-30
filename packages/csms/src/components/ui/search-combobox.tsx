// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from './input';

export interface SearchComboboxProps<T> {
  /** Id of the search field, so a `Label htmlFor` names it. */
  id?: string | undefined;
  /** The search text. */
  query: string;
  onQueryChange: (query: string) => void;
  /** The results for `query`; the caller searches (usually an API call). */
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  onSelect: (item: T) => void;
  placeholder?: string | undefined;
  'aria-label'?: string | undefined;
  /** Draws the border in the error color (a form error after a submit). */
  invalid?: boolean | undefined;
  autoFocus?: boolean | undefined;
  /** Shows an X button that calls this (closing an inline search). */
  onClose?: (() => void) | undefined;
  /** Accessible name of the X button. */
  closeLabel?: string | undefined;
  className?: string | undefined;
}

/**
 * The shared search picker: a search field whose results open in a listbox
 * under it. Pick with the mouse or the keyboard (arrow keys move, Enter picks,
 * Escape closes); the field is a `combobox` with `aria-activedescendant`, so a
 * screen reader follows the highlighted result. The caller owns the search
 * (`query`, `items`), so it works for any API list. Use it for a pick from
 * a list too long for a `Select` (drivers, stations, sessions).
 */
export function SearchCombobox<T>({
  id,
  query,
  onQueryChange,
  items,
  getKey,
  renderItem,
  onSelect,
  placeholder,
  'aria-label': ariaLabel,
  invalid,
  autoFocus,
  onClose,
  closeLabel,
  className,
}: SearchComboboxProps<T>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(-1);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const listId = React.useId();
  const shown = open && items.length > 0;

  React.useEffect(() => {
    if (!open) return;
    function handleDown(e: MouseEvent): void {
      if (containerRef.current != null && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleDown);
    return () => {
      document.removeEventListener('mousedown', handleDown);
    };
  }, [open]);

  React.useEffect(() => {
    if (!shown || highlight < 0 || listRef.current == null) return;
    const el = listRef.current.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight, shown]);

  function pick(item: T): void {
    onSelect(item);
    setOpen(false);
    setHighlight(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter' && shown && highlight >= 0) {
      const item = items[highlight];
      if (item != null) {
        e.preventDefault();
        pick(item);
      }
    } else if (e.key === 'Escape' && shown) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setHighlight(-1);
    }
  }

  const activeId = shown && highlight >= 0 ? `${listId}-${String(highlight)}` : undefined;

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        value={query}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid === true ? true : undefined}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        onChange={(e) => {
          onQueryChange(e.target.value);
          setOpen(true);
          // A new search starts without a highlighted result.
          setHighlight(-1);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        className={cn('pl-9', onClose != null && 'pr-9', invalid === true && 'border-destructive')}
      />
      {onClose != null && (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="absolute inset-y-0 right-3 flex items-center text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {shown && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((item, i) => (
            <li
              key={getKey(item)}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={() => {
                pick(item);
              }}
              onMouseEnter={() => {
                setHighlight(i);
              }}
              className={cn(
                'cursor-pointer rounded px-2 py-1.5 text-left text-sm',
                i === highlight && 'bg-accent text-accent-foreground',
              )}
            >
              {renderItem(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
