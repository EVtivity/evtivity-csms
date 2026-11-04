// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The message frame of VDV 463 (section 4.1, schema MessageStructure): a JSON
// array of seven items, type, source, presystem id, timestamp, message id,
// action and payload.

import {
  VDV463_ACTIONS,
  VDV463_CMS_SOURCE,
  VDV463_ERROR,
  type Vdv463Action,
  type Vdv463MessageType,
} from './constants.js';

export interface Vdv463Frame {
  type: Vdv463MessageType;
  source: string;
  presystemId: string;
  timestamp: string;
  messageId: string;
  action: Vdv463Action;
  /** An object; an error frame may carry a string (the 1.0 text) or an object. */
  payload: unknown;
}

export type Vdv463FrameRefusal = 'invalid_json' | 'invalid_frame' | 'unknown_action';

export type Vdv463ParseResult =
  | { ok: true; frame: Vdv463Frame }
  | {
      ok: false;
      reason: Vdv463FrameRefusal;
      /** What could be read, so the error frame answers the right message. */
      messageId?: string;
      action?: string;
      presystemId?: string;
      type?: number;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RFC 3339 date-time with a Z or an offset; fractions allowed.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function isVdv463Action(value: unknown): value is Vdv463Action {
  return typeof value === 'string' && (VDV463_ACTIONS as readonly string[]).includes(value);
}

/** Reads one text frame. Never throws. */
export function parseVdv463Frame(raw: string): Vdv463ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // fail-open: an unparseable frame is answered with an error frame, not thrown
    return { ok: false, reason: 'invalid_json' };
  }
  if (!Array.isArray(value)) return { ok: false, reason: 'invalid_frame' };
  const items: unknown[] = value;
  // The error frame echoes the message id only when it is a UUID and the action
  // only when it is a known one, so a peer never gets its own arbitrary text
  // (up to a frame of it) back (security review OCPP-I3).
  const read = {
    ...(typeof items[4] === 'string' && UUID.test(items[4]) ? { messageId: items[4] } : {}),
    ...(isVdv463Action(items[5]) ? { action: items[5] } : {}),
    ...(typeof items[2] === 'string' ? { presystemId: items[2] } : {}),
    ...(typeof items[0] === 'number' ? { type: items[0] } : {}),
  };
  if (items.length !== 7) return { ok: false, reason: 'invalid_frame', ...read };
  const [type, source, presystemId, timestamp, messageId, action, payload] = items;
  if (type !== 1 && type !== 2 && type !== 3)
    return { ok: false, reason: 'invalid_frame', ...read };
  if (
    typeof source !== 'string' ||
    typeof presystemId !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof messageId !== 'string' ||
    typeof action !== 'string'
  ) {
    return { ok: false, reason: 'invalid_frame', ...read };
  }
  if (!UUID.test(messageId) || !DATE_TIME.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    return { ok: false, reason: 'invalid_frame', ...read };
  }
  if (!isVdv463Action(action)) return { ok: false, reason: 'unknown_action', ...read };
  const payloadOk =
    isPlainObject(payload) || (type === VDV463_ERROR && typeof payload === 'string');
  if (!payloadOk) return { ok: false, reason: 'invalid_frame', ...read };
  return {
    ok: true,
    frame: { type, source, presystemId, timestamp, messageId, action, payload },
  };
}

/** UTC with the Z suffix and whole seconds (VDV issue #72). */
export function vdv463Timestamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

export interface Vdv463FrameOut {
  type: Vdv463MessageType;
  presystemId: string;
  timestamp: Date;
  messageId: string;
  /** An action this server knows, or the action of a frame it refuses. */
  action: string;
  payload: unknown;
}

export function writeVdv463Frame(frame: Vdv463FrameOut): string {
  return JSON.stringify([
    frame.type,
    VDV463_CMS_SOURCE,
    frame.presystemId,
    vdv463Timestamp(frame.timestamp),
    frame.messageId,
    frame.action,
    frame.payload,
  ]);
}

/**
 * An error frame. The payload is an object with `errorMessage`: the 1.1.0
 * schema wants an object payload, the 1.0 text a string (decision D7).
 */
export function vdv463ErrorFrame(
  presystemId: string,
  messageId: string,
  action: string,
  errorMessage: string,
  at: Date,
): string {
  return writeVdv463Frame({
    type: VDV463_ERROR,
    presystemId,
    timestamp: at,
    messageId,
    action,
    payload: { errorMessage },
  });
}

/** The text of an error frame payload, a string or `{ errorMessage }`. */
export function vdv463ErrorText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (isPlainObject(payload) && typeof payload['errorMessage'] === 'string') {
    return payload['errorMessage'];
  }
  return '';
}
