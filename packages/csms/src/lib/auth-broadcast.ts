// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib/safe-json';

/**
 * Tells the other tabs of this browser who is signed in. The session cookie
 * is shared by every tab, so a sign-out or a sign-in as another user in one
 * tab changes the session of all of them; each tab then drops what it holds
 * of the earlier user.
 */
export type AuthBroadcast = { type: 'signed-in'; userId: string } | { type: 'signed-out' };

const CHANNEL = 'evtivity-csms-auth';
const STORAGE_KEY = 'csms_auth_event';

function parse(value: unknown): AuthBroadcast | null {
  if (typeof value !== 'object' || value == null) return null;
  const msg = value as { type?: unknown; userId?: unknown };
  if (msg.type === 'signed-out') return { type: 'signed-out' };
  if (msg.type === 'signed-in' && typeof msg.userId === 'string' && msg.userId !== '') {
    return { type: 'signed-in', userId: msg.userId };
  }
  return null;
}

let channel: BroadcastChannel | null | undefined;

function openChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  } catch (err) {
    console.warn('Could not open the sign-in channel between tabs', err);
    channel = null;
  }
  return channel;
}

/** Sends the sign-in state to the other tabs (fail-open: a tab that misses it keeps its state). */
export function broadcastAuth(message: AuthBroadcast): void {
  const ch = openChannel();
  if (ch != null) {
    try {
      ch.postMessage(message);
      return;
    } catch (err) {
      console.warn('Could not tell the other tabs about the sign-in change', err);
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...message, at: Date.now() }));
  } catch (err) {
    console.warn('Could not tell the other tabs about the sign-in change', err);
  }
}

/** Calls `onMessage` for each sign-in change another tab sends. Returns the unsubscribe. */
export function listenAuthBroadcast(onMessage: (message: AuthBroadcast) => void): () => void {
  const ch = openChannel();
  if (ch != null) {
    const handler = (event: MessageEvent): void => {
      const msg = parse(event.data);
      if (msg != null) onMessage(msg);
    };
    ch.addEventListener('message', handler);
    return () => {
      ch.removeEventListener('message', handler);
    };
  }
  if (typeof window === 'undefined') return () => {};
  const handler = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || event.newValue == null) return;
    const msg = parse(tryParseJson(event.newValue));
    if (msg != null) onMessage(msg);
  };
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener('storage', handler);
  };
}

/** Test hook: forget the channel so a test can install its own BroadcastChannel. */
export function resetAuthBroadcastForTests(): void {
  channel?.close();
  channel = undefined;
}
