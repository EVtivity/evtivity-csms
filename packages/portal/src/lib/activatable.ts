// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type * as React from 'react';

/** The focus ring of a card that acts as a button or link (the Button focus style). */
export const ACTIVATABLE_FOCUS_CLASS =
  'outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background';

/**
 * Props that make a non-button element (a card or row) a keyboard button:
 * Tab reaches it, Enter or Space activates it, a click does too (WCAG 2.1.1,
 * 4.1.2). Pair it with `ACTIVATABLE_FOCUS_CLASS`.
 */
export function activatableProps(
  onActivate: () => void,
  label?: string,
): {
  role: 'button';
  tabIndex: 0;
  'aria-label'?: string;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
} {
  return {
    role: 'button',
    tabIndex: 0,
    ...(label != null ? { 'aria-label': label } : {}),
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
