// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { tryParseJson } from '@evtivity/lib';
import type { Logger } from '@evtivity/lib';
import {
  MESSAGE_TYPE_CALL,
  MESSAGE_TYPE_CALLERROR,
  MESSAGE_TYPE_CALLRESULT,
} from '../protocol/message-types.js';
import type { CallError, CallResult } from '../protocol/message-types.js';
import { OcppErrorCode } from '../protocol/error-codes.js';

/**
 * Checks on every frame a station sends, before the OCPP server logs or
 * processes it (OCPP-J 2.1 and 2.0.1 Part 4 section 4, OCPP-J 1.6 section 4):
 *
 * - Nesting: a frame nested deeper than `MAX_FRAME_DEPTH` (the frame array is
 *   level 1) is refused. No OCPP message nests that deep, and recursive code
 *   (masking, serialization) would overflow the stack on it.
 * - Message id: a string of 1 to 36 characters (OCPP-J "string[36]").
 * - Action: a string of 1 to `MAX_ACTION_LENGTH` characters.
 *
 * A CALL that fails a check is answered with a CALLERROR. A CALL whose message
 * id cannot be read (not a string of 1 to 36 characters) is answered with
 * message id "-1" and RpcFrameworkError (OCPP-J 2.1 Part 4 section 4.2.3).
 * Responses (CALLRESULT, CALLERROR) are never answered: a bad one is dropped
 * and counted, like every other frame that is not answered.
 */

export const MAX_FRAME_DEPTH = 32;
export const MAX_MESSAGE_ID_LENGTH = 36;
export const MAX_ACTION_LENGTH = 100;
/** Message id of a CALLERROR answering a CALL whose message id cannot be read. */
export const UNREADABLE_MESSAGE_ID = '-1';

// OCPP 2.1 message types this server never answers: CALLRESULTERROR (5) is a
// reply to one of its own CALLRESULTs, and SEND (6) is unconfirmed.
const MESSAGE_TYPE_CALLRESULTERROR = 5;
const MESSAGE_TYPE_SEND = 6;

export type DropReason =
  | 'invalid_json'
  | 'not_array'
  | 'invalid_message_id'
  | 'too_deep'
  | 'malformed_response'
  | 'unanswered_type'
  | 'unknown_type';

export type RefuseReason =
  | 'too_deep'
  | 'malformed_call'
  | 'invalid_action'
  | 'invalid_message_id'
  | 'unknown_type';

export type InboundFrame =
  | { kind: 'call'; messageId: string; action: string; payload: Record<string, unknown> }
  | { kind: 'response'; message: CallResult | CallError }
  | {
      kind: 'refuse';
      messageId: string;
      errorCode: OcppErrorCode;
      description: string;
      reason: RefuseReason;
    }
  | { kind: 'drop'; reason: DropReason };

/** Whether a JSON value nests containers deeper than `maxDepth` levels. Iterative. */
export function exceedsDepth(value: unknown, maxDepth: number): boolean {
  const stack: { node: object; depth: number }[] = [];
  if (value != null && typeof value === 'object') stack.push({ node: value, depth: 1 });
  for (let item = stack.pop(); item != null; item = stack.pop()) {
    if (item.depth > maxDepth) return true;
    const children: unknown[] = Array.isArray(item.node) ? item.node : Object.values(item.node);
    for (const child of children) {
      if (child != null && typeof child === 'object') {
        stack.push({ node: child, depth: item.depth + 1 });
      }
    }
  }
  return false;
}

function usableMessageId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MESSAGE_ID_LENGTH
    ? value
    : null;
}

function refuse(
  messageId: string,
  errorCode: OcppErrorCode,
  description: string,
  reason: RefuseReason,
): InboundFrame {
  return { kind: 'refuse', messageId, errorCode, description, reason };
}

/**
 * Classifies one inbound text frame. Error codes are the OCPP 2.x names; the
 * server turns them into the 1.6 names on a 1.6 connection
 * (`errorCodeForProtocol`).
 */
export function parseInboundFrame(raw: string, protocolVersion: string): InboundFrame {
  const json = tryParseJson(raw);
  if (json === undefined) return { kind: 'drop', reason: 'invalid_json' };
  if (!Array.isArray(json)) return { kind: 'drop', reason: 'not_array' };

  const frame = json as unknown[];
  const messageType = frame[0];
  const messageId = usableMessageId(frame[1]);

  if (messageType === MESSAGE_TYPE_CALLRESULT || messageType === MESSAGE_TYPE_CALLERROR) {
    // A response is never answered: anything wrong with it drops it.
    if (messageId == null) return { kind: 'drop', reason: 'invalid_message_id' };
    if (frame.length < 3) return { kind: 'drop', reason: 'malformed_response' };
    if (exceedsDepth(frame, MAX_FRAME_DEPTH)) return { kind: 'drop', reason: 'too_deep' };
    return { kind: 'response', message: frame as CallResult | CallError };
  }

  if (messageType === MESSAGE_TYPE_CALL) {
    if (messageId == null) {
      return refuse(
        UNREADABLE_MESSAGE_ID,
        OcppErrorCode.RpcFrameworkError,
        `The message id must be a string of 1 to ${String(MAX_MESSAGE_ID_LENGTH)} characters`,
        'invalid_message_id',
      );
    }
    if (exceedsDepth(frame, MAX_FRAME_DEPTH)) {
      return refuse(
        messageId,
        OcppErrorCode.FormatViolation,
        `Message nests deeper than ${String(MAX_FRAME_DEPTH)} levels`,
        'too_deep',
      );
    }
    if (frame.length < 4) {
      return refuse(
        messageId,
        OcppErrorCode.RpcFrameworkError,
        'A CALL has 4 elements: type, message id, action and payload',
        'malformed_call',
      );
    }
    const action = frame[2];
    if (typeof action !== 'string' || action.length === 0 || action.length > MAX_ACTION_LENGTH) {
      return refuse(
        messageId,
        OcppErrorCode.RpcFrameworkError,
        `The action must be a string of 1 to ${String(MAX_ACTION_LENGTH)} characters`,
        'invalid_action',
      );
    }
    return { kind: 'call', messageId, action, payload: frame[3] as Record<string, unknown> };
  }

  if (
    protocolVersion === 'ocpp2.1' &&
    (messageType === MESSAGE_TYPE_CALLRESULTERROR || messageType === MESSAGE_TYPE_SEND)
  ) {
    return { kind: 'drop', reason: 'unanswered_type' };
  }

  if (messageId == null) return { kind: 'drop', reason: 'unknown_type' };
  return refuse(
    messageId,
    OcppErrorCode.MessageTypeNotSupported,
    'Message type not supported',
    'unknown_type',
  );
}

const STATS_LOG_INTERVAL_MS = 5_000;

/**
 * Counts inbound frames that were dropped, refused or not logged, by reason,
 * and logs the counts at most once per interval, so a misbehaving station
 * cannot flood the process log.
 */
export class InboundFrameStats {
  private readonly totals = new Map<string, number>();
  private sinceLog = new Map<string, number>();
  private loggedAt = 0;

  constructor(
    private readonly logger: Logger,
    private readonly logIntervalMs: number = STATS_LOG_INTERVAL_MS,
  ) {}

  record(stationId: string, reason: string): void {
    this.totals.set(reason, (this.totals.get(reason) ?? 0) + 1);
    this.sinceLog.set(reason, (this.sinceLog.get(reason) ?? 0) + 1);
    const now = Date.now();
    if (now - this.loggedAt < this.logIntervalMs) return;
    this.logger.warn(
      { counts: Object.fromEntries(this.sinceLog), lastStationId: stationId },
      'Inbound OCPP frames dropped, refused or not logged',
    );
    this.loggedAt = now;
    this.sinceLog = new Map();
  }

  /** Totals by reason since the server started. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.totals);
  }
}
