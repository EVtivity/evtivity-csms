// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { MessageCorrelator } from '../server/message-correlator.js';
import { createSessionState } from '../server/session-state.js';
import type { CallResult, CallError } from '../protocol/message-types.js';

const logger = pino({ level: 'silent' });

function mockWs() {
  return {
    send: vi.fn((_data: string, cb?: (err?: Error) => void) => {
      if (cb != null) cb();
    }),
    close: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
  } as unknown as import('ws').default;
}

describe('MessageCorrelator', () => {
  let correlator: MessageCorrelator;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sendCall', () => {
    it('resolves with response payload on CALLRESULT', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const promise = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });

      // Extract the messageId from the sent message
      const sentData = JSON.parse(vi.mocked(ws.send).mock.calls[0]?.[0] as string) as unknown[];
      const messageId = sentData[1] as string;

      // Simulate CALLRESULT
      const callResult: CallResult = [3, messageId, { status: 'Accepted' }];
      correlator.handleResponse(session, callResult);

      const result = await promise;
      expect(result).toEqual({ status: 'Accepted' });
    });

    it('rejects with error on CALLERROR', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const promise = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });

      const sentData = JSON.parse(vi.mocked(ws.send).mock.calls[0]?.[0] as string) as unknown[];
      const messageId = sentData[1] as string;

      const callError: CallError = [4, messageId, 'InternalError', 'Something went wrong', {}];
      correlator.handleResponse(session, callError);

      await expect(promise).rejects.toThrow('CALLERROR InternalError: Something went wrong');
    });

    it('rejects on timeout', async () => {
      correlator = new MessageCorrelator(logger, 1000);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const promise = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });

      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow('Timeout waiting for response to Reset');
      expect(session.pendingMessages.size).toBe(0);
    });

    it('rejects on ws.send error', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = {
        send: vi.fn((_data: string, cb?: (err?: Error) => void) => {
          if (cb != null) cb(new Error('Send failed'));
        }),
        close: vi.fn(),
        on: vi.fn(),
        ping: vi.fn(),
      } as unknown as import('ws').default;
      const session = createSessionState('CS-001');

      const promise = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });

      await expect(promise).rejects.toThrow('Send failed');
      expect(session.pendingMessages.size).toBe(0);
    });
  });

  describe('handleResponse', () => {
    it('returns false for unknown messageId', () => {
      correlator = new MessageCorrelator(logger);
      const session = createSessionState('CS-001');

      const callResult: CallResult = [3, 'unknown-id', { status: 'Accepted' }];
      const handled = correlator.handleResponse(session, callResult);

      expect(handled).toBe(false);
    });

    it('returns true for known messageId', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const promise = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });

      const sentData = JSON.parse(vi.mocked(ws.send).mock.calls[0]?.[0] as string) as unknown[];
      const messageId = sentData[1] as string;

      const callResult: CallResult = [3, messageId, { status: 'Accepted' }];
      const handled = correlator.handleResponse(session, callResult);

      expect(handled).toBe(true);
      await promise;
    });

    it('clears timeout on successful response', async () => {
      correlator = new MessageCorrelator(logger, 5000);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const promise = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });

      const sentData = JSON.parse(vi.mocked(ws.send).mock.calls[0]?.[0] as string) as unknown[];
      const messageId = sentData[1] as string;

      const callResult: CallResult = [3, messageId, { status: 'Accepted' }];
      correlator.handleResponse(session, callResult);
      await promise;

      // Advancing past the timeout should not cause an error
      vi.advanceTimersByTime(6000);
      expect(session.pendingMessages.size).toBe(0);
    });
  });

  describe('clearPending', () => {
    it('rejects all pending messages with Connection closed error', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const promise1 = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });
      const promise2 = correlator.sendCall(ws, session, 'Heartbeat', {});

      expect(session.pendingMessages.size).toBe(2);

      correlator.clearPending(session);

      await expect(promise1).rejects.toThrow('Connection closed');
      await expect(promise2).rejects.toThrow('Connection closed');
      expect(session.pendingMessages.size).toBe(0);
    });

    it('handles empty pending map gracefully', () => {
      correlator = new MessageCorrelator(logger);
      const session = createSessionState('CS-001');

      correlator.clearPending(session);
      expect(session.pendingMessages.size).toBe(0);
    });
  });
});
