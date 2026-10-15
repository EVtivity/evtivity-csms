// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import {
  CommandQueueTimeoutError,
  CommandTimeoutError,
  MessageCorrelator,
} from '../server/message-correlator.js';
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
      await expect(promise).rejects.toBeInstanceOf(CommandTimeoutError);
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

    it('resolves when the action is not in the response registry (no schema to check)', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      // An action with no registry entry skips validation and resolves as-is.
      const promise = correlator.sendCall(ws, session, 'ActionWithNoRegistryEntry', {});

      const sentData = JSON.parse(vi.mocked(ws.send).mock.calls[0]?.[0] as string) as unknown[];
      const messageId = sentData[1] as string;

      const callResult: CallResult = [3, messageId, { anything: 'goes' }];
      const handled = correlator.handleResponse(session, callResult);

      expect(handled).toBe(true);
      await expect(promise).resolves.toEqual({ anything: 'goes' });
    });

    it('rejects when a CALLRESULT payload fails response schema validation', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const promise = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });

      const sentData = JSON.parse(vi.mocked(ws.send).mock.calls[0]?.[0] as string) as unknown[];
      const messageId = sentData[1] as string;

      // Reset's response schema requires a valid `status` enum; an invalid
      // value must be rejected, not resolved.
      const callResult: CallResult = [3, messageId, { status: 'NotARealResetStatus' }];
      const handled = correlator.handleResponse(session, callResult);

      expect(handled).toBe(true);
      await expect(promise).rejects.toThrow(
        'Invalid CALLRESULT for Reset: response payload failed schema validation',
      );
      expect(session.pendingMessages.size).toBe(0);
    });

    it('validates against the ocpp1.6 registry for 1.6 sessions', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001', 'ocpp1.6');

      const promise = correlator.sendCall(ws, session, 'Reset', { type: 'Hard' });

      const sentData = JSON.parse(vi.mocked(ws.send).mock.calls[0]?.[0] as string) as unknown[];
      const messageId = sentData[1] as string;

      const callResult: CallResult = [3, messageId, { status: 'Accepted' }];
      correlator.handleResponse(session, callResult);

      await expect(promise).resolves.toEqual({ status: 'Accepted' });
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

      // One outstanding CALL, the second waits in the queue.
      expect(session.pendingMessages.size).toBe(1);

      correlator.clearPending(session);

      await expect(promise1).rejects.toThrow('Connection closed');
      await expect(promise2).rejects.toThrow('Connection closed');
      expect(session.pendingMessages.size).toBe(0);
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it('handles empty pending map gracefully', () => {
      correlator = new MessageCorrelator(logger);
      const session = createSessionState('CS-001');

      correlator.clearPending(session);
      expect(session.pendingMessages.size).toBe(0);
    });

    it('rejects a CALL made after the session closed without sending it', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      correlator.clearPending(session);

      await expect(correlator.sendCall(ws, session, 'Reset', {})).rejects.toThrow(
        'Connection closed',
      );
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('one outstanding CALL per station', () => {
    function sentId(ws: import('ws').default, index: number): string {
      const sent = JSON.parse(vi.mocked(ws.send).mock.calls[index]?.[0] as string) as unknown[];
      return sent[1] as string;
    }

    function sentAction(ws: import('ws').default, index: number): string {
      const sent = JSON.parse(vi.mocked(ws.send).mock.calls[index]?.[0] as string) as unknown[];
      return sent[2] as string;
    }

    it('sends the next CALL only after the previous one got its CALLRESULT, in FIFO order', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const first = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });
      const second = correlator.sendCall(ws, session, 'ClearCache', {});
      const third = correlator.sendCall(ws, session, 'GetLocalListVersion', {});
      expect(ws.send).toHaveBeenCalledTimes(1);

      correlator.handleResponse(session, [3, sentId(ws, 0), { status: 'Accepted' }]);
      await expect(first).resolves.toEqual({ status: 'Accepted' });
      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalledTimes(2);
      });
      expect(sentAction(ws, 1)).toBe('ClearCache');

      correlator.handleResponse(session, [3, sentId(ws, 1), { status: 'Accepted' }]);
      await expect(second).resolves.toEqual({ status: 'Accepted' });
      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalledTimes(3);
      });
      expect(sentAction(ws, 2)).toBe('GetLocalListVersion');

      correlator.handleResponse(session, [3, sentId(ws, 2), { versionNumber: 1 }]);
      await expect(third).resolves.toEqual({ versionNumber: 1 });
    });

    it('sends the next CALL after a CALLERROR', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const first = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });
      const second = correlator.sendCall(ws, session, 'ClearCache', {});

      correlator.handleResponse(session, [4, sentId(ws, 0), 'InternalError', 'boom', {}]);
      await expect(first).rejects.toThrow('CALLERROR InternalError');
      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalledTimes(2);
      });
      correlator.handleResponse(session, [3, sentId(ws, 1), { status: 'Accepted' }]);
      await expect(second).resolves.toEqual({ status: 'Accepted' });
    });

    it('sends the next CALL after a send failure', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      vi.mocked(ws.send).mockImplementationOnce(((_d: string, cb?: (err?: Error) => void) => {
        if (cb != null) cb(new Error('socket gone'));
      }) as never);
      const session = createSessionState('CS-001');

      const first = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });
      const second = correlator.sendCall(ws, session, 'ClearCache', {});

      await expect(first).rejects.toThrow('socket gone');
      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalledTimes(2);
      });
      correlator.handleResponse(session, [3, sentId(ws, 1), { status: 'Accepted' }]);
      await expect(second).resolves.toEqual({ status: 'Accepted' });
    });

    it('measures the response timeout from the actual send', async () => {
      correlator = new MessageCorrelator(logger, 1000);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const first = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });
      const second = correlator.sendCall(ws, session, 'ClearCache', {});
      const secondOutcome = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      // The first CALL is answered after 800 ms, so the second is sent then.
      await vi.advanceTimersByTimeAsync(800);
      correlator.handleResponse(session, [3, sentId(ws, 0), { status: 'Accepted' }]);
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).toHaveBeenCalledTimes(2);

      // 900 ms after its send (1700 ms after its enqueue) it is still waiting.
      await vi.advanceTimersByTimeAsync(900);
      correlator.handleResponse(session, [3, sentId(ws, 1), { status: 'Accepted' }]);
      await expect(secondOutcome).resolves.toEqual({ value: { status: 'Accepted' } });
    });

    it('sends the next CALL after the previous one timed out', async () => {
      correlator = new MessageCorrelator(logger, 1000);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const first = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });
      const firstOutcome = first.catch((error: unknown) => error);
      // Queued after 500 ms, so its own wait limit is not reached when the
      // first CALL times out at 1000 ms.
      await vi.advanceTimersByTimeAsync(500);
      const second = correlator.sendCall(ws, session, 'ClearCache', {});

      await vi.advanceTimersByTimeAsync(500);
      expect(await firstOutcome).toBeInstanceOf(CommandTimeoutError);
      await vi.advanceTimersByTimeAsync(0);
      expect(ws.send).toHaveBeenCalledTimes(2);

      correlator.handleResponse(session, [3, sentId(ws, 1), { status: 'Accepted' }]);
      await expect(second).resolves.toEqual({ status: 'Accepted' });
    });

    it('rejects a CALL that waited the whole timeout without sending it', async () => {
      correlator = new MessageCorrelator(logger, 1000);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      // All three at once: the first times out at 1000 ms and hands the lane
      // to the second, while the third has then waited its whole limit.
      const first = correlator.sendCall(ws, session, 'Reset', { type: 'Immediate' });
      const firstOutcome = first.catch((error: unknown) => error);
      const second = correlator.sendCall(ws, session, 'ClearCache', {});
      const third = correlator.sendCall(ws, session, 'GetLocalListVersion', {});
      const thirdOutcome = third.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(1000);
      expect(await firstOutcome).toBeInstanceOf(CommandTimeoutError);
      const thirdError = await thirdOutcome;
      expect(thirdError).toBeInstanceOf(CommandQueueTimeoutError);
      expect(thirdError).not.toBeInstanceOf(CommandTimeoutError);
      // The third was never sent.
      expect(ws.send).toHaveBeenCalledTimes(2);
      expect(sentAction(ws, 1)).toBe('ClearCache');

      correlator.handleResponse(session, [3, sentId(ws, 1), { status: 'Accepted' }]);
      await expect(second).resolves.toEqual({ status: 'Accepted' });

      // The lane is free again: the next CALL goes out at once.
      const fourth = correlator.sendCall(ws, session, 'ClearCache', {});
      expect(ws.send).toHaveBeenCalledTimes(3);
      correlator.handleResponse(session, [3, sentId(ws, 2), { status: 'Accepted' }]);
      await expect(fourth).resolves.toEqual({ status: 'Accepted' });
    });

    it('runs onSend when the CALL is sent, after it waited, and never for an unsent CALL', async () => {
      correlator = new MessageCorrelator(logger, 1000);
      const ws = mockWs();
      const session = createSessionState('CS-001');
      const order: string[] = [];
      const onSend = (name: string) => ({
        onSend: () => {
          order.push(`${name}:${String(vi.mocked(ws.send).mock.calls.length)}`);
        },
      });

      const first = correlator.sendCall(ws, session, 'Reset', {}, onSend('first'));
      const second = correlator.sendCall(ws, session, 'ClearCache', {}, onSend('second'));
      const secondOutcome = second.catch((error: unknown) => error);
      const third = correlator.sendCall(ws, session, 'GetLocalListVersion', {}, onSend('third'));
      const thirdOutcome = third.catch((error: unknown) => error);
      // Only the first went out, and its hook ran right before the write.
      expect(order).toEqual(['first:0']);

      correlator.handleResponse(session, [3, sentId(ws, 0), { status: 'Accepted' }]);
      await first;
      await vi.waitFor(() => {
        expect(order).toEqual(['first:0', 'second:1']);
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(await thirdOutcome).toBeInstanceOf(CommandQueueTimeoutError);
      expect(await secondOutcome).toBeInstanceOf(CommandTimeoutError);
      // The third was never sent, so its hook never ran.
      expect(order).toEqual(['first:0', 'second:1']);
    });

    it('sends the CALL when the onSend hook throws', async () => {
      correlator = new MessageCorrelator(logger);
      const ws = mockWs();
      const session = createSessionState('CS-001');

      const call = correlator.sendCall(
        ws,
        session,
        'Reset',
        {},
        {
          onSend: () => {
            throw new Error('log failed');
          },
        },
      );
      expect(ws.send).toHaveBeenCalledTimes(1);
      correlator.handleResponse(session, [3, sentId(ws, 0), { status: 'Accepted' }]);
      await expect(call).resolves.toEqual({ status: 'Accepted' });
    });

    it('keeps one lane per session', async () => {
      correlator = new MessageCorrelator(logger);
      const wsA = mockWs();
      const wsB = mockWs();
      const sessionA = createSessionState('CS-A');
      const sessionB = createSessionState('CS-B');

      void correlator.sendCall(wsA, sessionA, 'Reset', {}).catch(() => undefined);
      void correlator.sendCall(wsB, sessionB, 'Reset', {}).catch(() => undefined);

      expect(wsA.send).toHaveBeenCalledTimes(1);
      expect(wsB.send).toHaveBeenCalledTimes(1);
      correlator.clearPending(sessionA);
      correlator.clearPending(sessionB);
    });
  });
});
