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

  constructor(logger: Logger, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  async sendCall(
    ws: WebSocket,
    session: SessionState,
    action: string,
    payload: Record<string, unknown>,
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
        reject(new Error(`Timeout waiting for response to ${action} (${messageId})`));
      }, this.timeoutMs);

      session.pendingMessages.set(messageId, {
        messageId,
        action,
        sentAt: new Date(),
        resolve,
        reject,
        timeout,
      });

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
