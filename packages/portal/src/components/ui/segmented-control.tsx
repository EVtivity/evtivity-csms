// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: LucideIcon;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedControlOption<T>[];
  'aria-label': string;
  /** Width and layout only (`w-full`, margins); the control sets its own height and look. */
  className?: string;
  /** `compact`: tighter padding and smaller text, for many short labels (the seven weekdays). */
  size?: 'default' | 'compact';
}

/**
 * Picks one of a few views (Energy or Power, Upcoming or Past). A WAI-ARIA
 * radio group, not a tab list: the options switch the content below, they do
 * not label tab panels. The arrow keys, Home and End move the focus and select,
 * and only the selected option is in the tab order (roving tabIndex).
 *
 * 40 px high (the portal button height). The segments share the width equally:
 * as wide as the longest label when the control sizes itself, filling the row
 * when it is `w-full`, where a long label wraps instead of clipping.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  'aria-label': ariaLabel,
  className,
  size = 'default',
}: SegmentedControlProps<T>): React.JSX.Element {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const focusIndex = selectedIndex === -1 ? 0 : selectedIndex;

  function select(index: number): void {
    const option = options[index];
    if (option == null) return;
    refs.current[index]?.focus();
    if (option.value !== value) onValueChange(option.value);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = options.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = index === last ? 0 : index + 1;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = index === 0 ? last : index - 1;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    }
    if (next == null) return;
    event.preventDefault();
    select(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-grid min-h-10 auto-cols-fr grid-flow-col gap-1 rounded-md bg-muted p-1',
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === focusIndex ? 0 : -1}
            className={cn(
              'inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded-sm border py-1 text-center font-medium leading-tight ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none',
              // Compact labels are short (three-letter days): no side padding on phones and
              // never broken mid-word, or "MON" splits on a 360 px screen.
              size === 'compact'
                ? 'px-0 text-xs uppercase whitespace-nowrap sm:px-2'
                : 'px-3 text-sm',
              checked
                ? 'border-border bg-card text-foreground shadow-xs'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
            onClick={() => {
              select(index);
            }}
            onKeyDown={(event) => {
              handleKeyDown(event, index);
            }}
          >
            {Icon != null && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 wrap-break-word">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
