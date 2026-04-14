// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { GracefulShutdown } from '../server/graceful-shutdown.js';
import { ConnectionManager } from '../server/connection-manager.js';
import { MessageCorrelator } from '../server/message-correlator.js';
import { createSessionState } from '../server/session-state.js';

const logger = pino({ level: 'silent' });

function mockWs() {
  return {
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
  } as unknown as import('ws').default;
}

function mockWss() {
  return {
    close: vi.fn((cb?: () => void) => {
      if (cb != null) cb();
    }),
  } as unknown as import('ws').WebSocketServer;
}

describe('GracefulShutdown', () => {
  let cm: ConnectionManager;
  let correlator: MessageCorrelator;

  beforeEach(() => {
    vi.useFakeTimers();
    cm = new ConnectionManager(logger);
    correlator = new MessageCorrelator(logger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports isShuttingDown as false initially', () => {
    const wss = mockWss();
    const shutdown = new GracefulShutdown(wss, cm, correlator, logger);
    expect(shutdown.isShuttingDown()).toBe(false);
  });

  it('sets isShuttingDown to true after shutdown called', async () => {
    const wss = mockWss();
    const shutdown = new GracefulShutdown(wss, cm, correlator, logger);

    const promise = shutdown.shutdown();
    // No connections, so it resolves immediately at the next tick
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(shutdown.isShuttingDown()).toBe(true);
  });

  it('closes the WebSocketServer on shutdown', async () => {
    const wss = mockWss();
    const shutdown = new GracefulShutdown(wss, cm, correlator, logger);

    const promise = shutdown.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(wss.close).toHaveBeenCalled();
  });

  it('closes all active connections on shutdown', async () => {
    const wss = mockWss();
    const ws1 = mockWs();
    const ws2 = mockWs();
    const session1 = createSessionState('CS-001');
    const session2 = createSessionState('CS-002');
    cm.add('CS-001', ws1, session1);
    cm.add('CS-002', ws2, session2);

    const shutdown = new GracefulShutdown(wss, cm, correlator, logger);

    // Simulate connections closing when close() is called
    vi.mocked(ws1.close).mockImplementation(() => {
      cm.remove('CS-001');
    });
    vi.mocked(ws2.close).mockImplementation(() => {
      cm.remove('CS-002');
    });

    const promise = shutdown.shutdown();
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(ws1.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(ws2.close).toHaveBeenCalledWith(1001, 'Server shutting down');
  });

  it('is idempotent - second shutdown call returns immediately', async () => {
    const wss = mockWss();
    const shutdown = new GracefulShutdown(wss, cm, correlator, logger);

    const p1 = shutdown.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    await p1;

    // Second call should return immediately without calling close again
    vi.mocked(wss.close).mockClear();
    await shutdown.shutdown();
    expect(wss.close).not.toHaveBeenCalled();
  });

  it('terminates connections when shutdown timeout is reached', async () => {
    const wss = mockWss();
    const ws = mockWs();
    const session = createSessionState('CS-001');
    cm.add('CS-001', ws, session);

    const shutdown = new GracefulShutdown(wss, cm, correlator, logger);

    // Do not simulate the connection closing, so it stays open
    const promise = shutdown.shutdown();

    // Advance past the 10 second shutdown timeout
    await vi.advanceTimersByTimeAsync(10_100);
    await promise;

    expect(ws.terminate).toHaveBeenCalled();
  });

  it('resolves when connections close before timeout', async () => {
    const wss = mockWss();
    const ws = mockWs();
    const session = createSessionState('CS-001');
    cm.add('CS-001', ws, session);

    const shutdown = new GracefulShutdown(wss, cm, correlator, logger);

    const promise = shutdown.shutdown();

    // Simulate connection closing after 500ms
    await vi.advanceTimersByTimeAsync(200);
    cm.remove('CS-001');
    await vi.advanceTimersByTimeAsync(200);

    await promise;
    expect(shutdown.isShuttingDown()).toBe(true);
  });

  it('clears pending messages for all sessions on shutdown', async () => {
    const wss = mockWss();
    const ws = mockWs();
    const session = createSessionState('CS-001');
    // Add a fake pending message
    session.pendingMessages.set('msg-1', {
      messageId: 'msg-1',
      action: 'Reset',
      sentAt: new Date(),
      resolve: vi.fn(),
      reject: vi.fn(),
      timeout: setTimeout(() => {}, 30_000),
    });
    cm.add('CS-001', ws, session);

    vi.mocked(ws.close).mockImplementation(() => {
      cm.remove('CS-001');
    });

    const shutdown = new GracefulShutdown(wss, cm, correlator, logger);
    const promise = shutdown.shutdown();
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(session.pendingMessages.size).toBe(0);
  });
});
