// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback } from 'react';
import { useLocation, useNavigate, type Location, type NavigateOptions } from 'react-router';

// Navigation state a list puts on the links to its detail pages, so the
// detail page's back goes back in history to that same list entry.
export interface FromParentState {
  from: string;
}

export function fromParent(parent: string): NavigateOptions {
  return { state: { from: parent } satisfies FromParentState };
}

export function cameFrom(state: unknown, parent: string): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as Partial<FromParentState>).from === parent
  );
}

/**
 * True on the first page of a visit, which has nothing in the app to go back
 * to. In the browser, BrowserRouter numbers its history entries (`idx` in
 * `window.history.state`, kept across a reload), and the first one is 0. A
 * router without that index (MemoryRouter) keys its first entry 'default'. A
 * page that replaced the first entry also carries visitStart in its state.
 */
export function isVisitStart(location: Pick<Location, 'key' | 'state'>): boolean {
  if (
    typeof location.state === 'object' &&
    location.state !== null &&
    (location.state as { visitStart?: unknown }).visitStart === true
  ) {
    return true;
  }
  const idx: unknown =
    typeof window === 'undefined'
      ? undefined
      : (window.history.state as { idx?: unknown } | null)?.idx;
  if (typeof idx === 'number') return idx === 0;
  return location.key === 'default';
}

/**
 * Back for a page that has one parent list (a support case, the new case
 * form). Opened from that list, it goes back in history to it, so the list
 * keeps its own back to where the driver came from. Opened another way (a
 * link, a notification, a page load), it replaces itself with the list rather
 * than pushing a second list entry on top of itself; the list then knows
 * when it is the first page of the visit (isVisitStart).
 */
export function useBackToParent(parent: string): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (cameFrom(location.state, parent)) {
      void navigate(-1);
      return;
    }
    void navigate(parent, {
      replace: true,
      state: isVisitStart(location) ? { visitStart: true } : null,
    });
  }, [location, navigate, parent]);
}
