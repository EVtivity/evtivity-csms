// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Input } from './input';

interface ComboboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  options: string[];
}

/**
 * Free-text input with a typeahead suggestions popup. The user can either
 * pick from the filtered list or type a value not in the list. Built for
 * Safari (the native HTML <datalist> does not show a visible dropdown
 * affordance there). Keyboard: arrow keys navigate, Enter selects, Esc closes.
 */
export const Combobox = React.forwardRef<HTMLInputElement, ComboboxProps>(
  ({ value, onChange, options, className, disabled, onFocus, onBlur, ...props }, ref) => {
    const { t } = useTranslation();
    const [open, setOpen] = React.useState(false);
    const [highlight, setHighlight] = React.useState(-1);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const listRef = React.useRef<HTMLUListElement>(null);

    const filtered = React.useMemo(() => {
      const q = value.trim().toLowerCase();
      if (q === '') return options;
      return options.filter((o) => o.toLowerCase().includes(q));
    }, [options, value]);

    // Close when clicking outside.
    React.useEffect(() => {
      if (!open) return;
      function handleDown(e: MouseEvent): void {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          setOpen(false);
        }
      }
      document.addEventListener('mousedown', handleDown);
      return () => {
        document.removeEventListener('mousedown', handleDown);
      };
    }, [open]);

    // Keep highlighted option scrolled into view.
    React.useEffect(() => {
      if (!open || highlight < 0 || listRef.current == null) return;
      const el = listRef.current.children[highlight] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }, [highlight, open]);

    function selectOption(opt: string): void {
      onChange(opt);
      setOpen(false);
      setHighlight(-1);
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setHighlight(0);
          return;
        }
        setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) return;
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter' && open && highlight >= 0) {
        const opt = filtered[highlight];
        if (opt != null) {
          e.preventDefault();
          selectOption(opt);
        }
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
        setHighlight(-1);
      }
    }

    return (
      <div ref={containerRef} className="relative">
        <Input
          ref={ref}
          {...props}
          className={cn('pr-9', className)}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlight(-1);
          }}
          onFocus={(e) => {
            setOpen(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            // Defer close so a click on a list item registers first.
            window.setTimeout(() => {
              setOpen(false);
            }, 150);
            onBlur?.(e);
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('common.toggleSuggestions')}
          onClick={() => {
            if (disabled === true) return;
            setOpen((prev) => !prev);
          }}
          className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
        {open && filtered.length > 0 && (
          <ul
            ref={listRef}
            role="listbox"
            className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          >
            {filtered.map((opt, i) => (
              <li
                key={opt}
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => {
                  // Prevent the input blur from firing before the click.
                  e.preventDefault();
                }}
                onClick={() => {
                  selectOption(opt);
                }}
                onMouseEnter={() => {
                  setHighlight(i);
                }}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm',
                  i === highlight ? 'bg-accent text-accent-foreground' : '',
                )}
              >
                {opt}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);

Combobox.displayName = 'Combobox';
