// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { Logger } from '@evtivity/lib';
import { createCall, isCallResult, isCallError } from '../protocol/message-types.js';
import type { CallResult, CallError } from '../protocol/message-types.js';
import type { SessionState } from './session-state.js';
import { ActionRegistry as Registry21 } from '../generated/v2_1/registry.js';
import { ActionRegistry as Registry16 } from '../generated/v1_6/registry.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The station did not answer a CALL within the correlator timeout. Callers
 * tell a station non-answer apart from a failure by this type, never by the
 * message text.
 */
export class CommandTimeoutError extends Error {
  constructor(action: string, messageId: string) {
    super(`Timeout waiting for response to ${action} (${messageId})`);
    this.name = 'CommandTimeoutError';
  }
}

/**
 * A CALL waited behind the station's outstanding CALL for the whole
 * correlator timeout and was never sent. Unlike CommandTimeoutError, the
 * station never saw it, so nothing it asked for can still happen.
 */
export class CommandQueueTimeoutError extends Error {
  constructor(action: string) {
    super(`Timeout waiting to send ${action}: the station did not answer the previous CALL`);
    this.name = 'CommandQueueTimeoutError';
  }
}

/** Options of one outgoing CALL. */
export interface SendCallOptions {
  /**
   * Runs when the CALL goes out to the station: right before the frame is
   * written, after any wait behind the station's outstanding CALL. A CALL
   * that is never sent (queue timeout, closed connection) never runs it.
   * A throw is logged and the CALL is still sent.
   */
  onSend?: () => void;
}

interface QueuedCall {
  action: string;
  timer: ReturnType<typeof setTimeout>;
  start: () => void;
  fail: (error: Error) => void;
}

/**
 * Outgoing CALL lane of one station connection. OCPP-J (1.6 section 4.1.1,
 * 2.x part 4 section 4.1.1) allows one outstanding CALL per direction: the
 * next CALL is sent only after the previous one got its CALLRESULT or
 * CALLERROR or timed out.
 */
interface CallLane {
  busy: boolean;
  closed: boolean;
  queue: QueuedCall[];
}

interface RegistryEntry {
  validateResponse: (data: unknown) => boolean;
}
interface RegistryEntryWithErrors extends RegistryEntry {
  validateResponse: { errors?: unknown[] | null } & ((data: unknown) => boolean);
}

function validateCallResultPayload(
  protocolVersion: string,
  action: string,
  payload: unknown,
): { ok: true } | { ok: false; errors: unknown[] } {
  const registry = (protocolVersion === 'ocpp1.6' ? Registry16 : Registry21) as Record<
    string,
    RegistryEntryWithErrors | undefined
  >;
  const entry = registry[action];
  if (entry == null) return { ok: true };
  if (entry.validateResponse(payload)) return { ok: true };
  return { ok: false, errors: entry.validateResponse.errors ?? [] };
}

export class MessageCorrelator {
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly lanes = new WeakMap<SessionState, CallLane>();

  constructor(logger: Logger, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Sends a CALL and resolves with the CALLRESULT payload. CALLs to one
   * station go out one at a time in FIFO order: a CALL made while another is
   * outstanding waits for it to settle (result, error, timeout or send
   * failure). The response timeout runs from the actual send. A CALL still
   * waiting after the timeout is rejected with CommandQueueTimeoutError and
   * never sent, so a station that stopped answering cannot receive a stale
   * command long after its caller gave up. Closing the session rejects every
   * waiting CALL with "Connection closed". `options.onSend` runs when the
   * CALL is actually sent, so a caller records CALLs in wire order.
   */
  async sendCall(
    ws: WebSocket,
    session: SessionState,
    action: string,
    payload: Record<string, unknown>,
    options?: SendCallOptions,
  ): Promise<Record<string, unknown>> {
    const lane = this.laneFor(session);
    if (lane.closed) {
      throw new Error('Connection closed');
    }
    if (!lane.busy) {
      lane.busy = true;
      return this.sendAndRelease(ws, session, lane, action, payload, options);
    }

    this.logger.debug(
      { stationId: session.stationId, action, queued: lane.queue.length + 1 },
      'Queued CALL behind the outstanding CALL to the station',
    );
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: QueuedCall = {
        action,
        timer: setTimeout(() => {
          const index = lane.queue.indexOf(entry);
          if (index >= 0) lane.queue.splice(index, 1);
          this.logger.warn(
            { stationId: session.stationId, action },
            'CALL not sent: the station did not answer the previous CALL in time',
          );
          reject(new CommandQueueTimeoutError(action));
        }, this.timeoutMs),
        start: () => {
          clearTimeout(entry.timer);
          this.sendAndRelease(ws, session, lane, action, payload, options).then(resolve, reject);
        },
        fail: (error: Error) => {
          clearTimeout(entry.timer);
          reject(error);
        },
      };
      lane.queue.push(entry);
    });
  }

  private laneFor(session: SessionState): CallLane {
    let lane = this.lanes.get(session);
    if (lane == null) {
      lane = { busy: false, closed: false, queue: [] };
      this.lanes.set(session, lane);
    }
    return lane;
  }

  // Sends now and hands the lane to the next waiting CALL once this one
  // settles, whatever the outcome.
  private sendAndRelease(
    ws: WebSocket,
    session: SessionState,
    lane: CallLane,
    action: string,
    payload: Record<string, unknown>,
    options: SendCallOptions | undefined,
  ): Promise<Record<string, unknown>> {
    const sent = this.sendNow(ws, session, action, payload, options);
    const release = (): void => {
      const next = lane.queue.shift();
      if (next == null) {
        lane.busy = false;
        return;
      }
      next.start();
    };
    sent.then(release, release);
    return sent;
  }

  private sendNow(
    ws: WebSocket,
    session: SessionState,
    action: string,
    payload: Record<string, unknown>,
    options: SendCallOptions | undefined,
  ): Promise<Record<string, unknown>> {
    const messageId = randomUUID();
    const call = createCall(messageId, action, payload);

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pendingMessages.delete(messageId);
        this.logger.warn(
          { stationId: session.stationId, messageId, action },
          'Timeout waiting for CALLRESULT from station',
        );
        reject(new CommandTimeoutError(action, messageId));
      }, this.timeoutMs);

      session.pendingMessages.set(messageId, {
        messageId,
        action,
        sentAt: new Date(),
        resolve,
        reject,
        timeout,
      });

      if (options?.onSend != null) {
        try {
          options.onSend();
        } catch (err) {
          // fail-open: the record of the CALL must not stop the CALL itself.
          this.logger.warn(
            { stationId: session.stationId, messageId, action, err },
            'CALL send hook failed',
          );
        }
      }

      ws.send(JSON.stringify(call), (err) => {
        if (err != null) {
          clearTimeout(timeout);
          session.pendingMessages.delete(messageId);
          this.logger.error(
            { stationId: session.stationId, messageId, action, err: err.message },
            'Failed to send CALL to station',
          );
          reject(err);
        }
      });

      this.logger.debug(
        { stationId: session.stationId, messageId, action },
        'Sent CALL to station',
      );
    });
  }

  handleResponse(session: SessionState, message: CallResult | CallError): boolean {
    const messageId = message[1];
    const pending = session.pendingMessages.get(messageId);

    if (pending == null) {
      this.logger.warn(
        { stationId: session.stationId, messageId },
        'Received response for unknown or already-timed-out messageId',
      );
      return false;
    }

    clearTimeout(pending.timeout);
    session.pendingMessages.delete(messageId);

    if (isCallResult(message)) {
      const validation = validateCallResultPayload(
        session.ocppProtocol,
        pending.action,
        message[2],
      );
      if (!validation.ok) {
        this.logger.error(
          {
            stationId: session.stationId,
            messageId,
            action: pending.action,
            errors: validation.errors,
          },
          'Station sent a CALLRESULT that does not match the response schema',
        );
        pending.reject(
          new Error(
            `Invalid CALLRESULT for ${pending.action}: response payload failed schema validation`,
          ),
        );
        return true;
      }
      pending.resolve(message[2]);
    } else if (isCallError(message)) {
      pending.reject(new Error(`CALLERROR ${message[2]}: ${message[3]}`));
    }

    return true;
  }

  clearPending(session: SessionState): void {
    const lane = this.laneFor(session);
    lane.closed = true;
    const waiting = lane.queue.splice(0);
    if (waiting.length > 0) {
      this.logger.warn(
        {
          stationId: session.stationId,
          count: waiting.length,
          actions: waiting.map((q) => q.action),
        },
        'Dropping queued CALLs because the station session closed',
      );
    }
    for (const queued of waiting) {
      queued.fail(new Error('Connection closed'));
    }

    if (session.pendingMessages.size > 0) {
      const aborted = Array.from(session.pendingMessages.values()).map((p) => ({
        action: p.action,
        messageId: p.messageId,
        pendingMs: Date.now() - p.sentAt.getTime(),
      }));
      this.logger.warn(
        { stationId: session.stationId, count: aborted.length, aborted },
        'Aborting pending CALLs because the station session closed',
      );
    }
    for (const pending of session.pendingMessages.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    session.pendingMessages.clear();
  }
}
