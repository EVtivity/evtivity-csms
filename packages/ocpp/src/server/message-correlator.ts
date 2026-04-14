// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { Logger } from '@evtivity/lib';
import { createCall, isCallResult, isCallError } from '../protocol/message-types.js';
import type { CallResult, CallError } from '../protocol/message-types.js';
import type { SessionState } from './session-state.js';

const DEFAULT_TIMEOUT_MS = 30_000;

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
          reject(err);
        }
      });

      this.logger.debug({ messageId, action }, 'Sent CALL to station');
    });
  }

  handleResponse(session: SessionState, message: CallResult | CallError): boolean {
    const messageId = message[1];
    const pending = session.pendingMessages.get(messageId);

    if (pending == null) {
      this.logger.warn({ messageId }, 'Received response for unknown message');
      return false;
    }

    clearTimeout(pending.timeout);
    session.pendingMessages.delete(messageId);

    if (isCallResult(message)) {
      pending.resolve(message[2]);
    } else if (isCallError(message)) {
      pending.reject(new Error(`CALLERROR ${message[2]}: ${message[3]}`));
    }

    return true;
  }

  clearPending(session: SessionState): void {
    for (const pending of session.pendingMessages.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    session.pendingMessages.clear();
  }
}
