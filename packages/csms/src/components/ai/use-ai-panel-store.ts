// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { create } from 'zustand';
import type { AiContextKind } from '@evtivity/lib/ai-insights';

/** The record an Explain conversation is about. The server checks access on every turn. */
export interface AiPanelContext {
  kind: AiContextKind;
  id: string;
  /** Shown in the panel (such as the OCPP station id); never sent to the server. */
  label?: string;
}

/** What the panel shows when a page opens it through Explain. */
export interface AiPanelRequest {
  context: AiPanelContext;
  /** Changes on every request, so the same record can be explained twice. */
  seq: number;
}

/**
 * How the panel closed. `outside`: a click outside it, which may have moved
 * focus to what was clicked; focus goes back only when it was lost.
 */
export type AiPanelCloseReason = 'dismiss' | 'outside';

interface AiPanelState {
  open: boolean;
  request: AiPanelRequest | null;
  /** Where focus was when the panel opened; it goes back there on close. */
  returnFocus: HTMLElement | null;
  /** Opens the panel on a plain new chat (launcher button, Ctrl/Cmd+K). */
  openPanel: () => void;
  /** Opens the panel about one record: its context card and a prefilled Explain question. */
  openWithContext: (context: AiPanelContext) => void;
  close: (reason?: AiPanelCloseReason) => void;
  /** Clears a handled request so a later plain open starts a normal chat. */
  clearRequest: () => void;
}

function focusedElement(): HTMLElement | null {
  return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
}

/**
 * The AI panel's open state, shared so any page can open it (Explain buttons,
 * insight cards). The launcher renders the panel from this store.
 */
export const useAiPanelStore = create<AiPanelState>((set, get) => ({
  open: false,
  request: null,
  returnFocus: null,
  openPanel: () => {
    if (get().open) return;
    set({ open: true, returnFocus: focusedElement() });
  },
  openWithContext: (context) => {
    set({
      open: true,
      returnFocus: get().open ? get().returnFocus : focusedElement(),
      request: { context, seq: (get().request?.seq ?? 0) + 1 },
    });
  },
  close: (reason = 'dismiss') => {
    const target = get().returnFocus;
    set({ open: false, returnFocus: null });
    setTimeout(() => {
      // A click outside that focused something keeps that focus.
      if (reason === 'outside') {
        const active = focusedElement();
        if (active != null && active !== document.body) return;
      }
      target?.focus();
    }, 0);
  },
  clearRequest: () => {
    set({ request: null });
  },
}));
