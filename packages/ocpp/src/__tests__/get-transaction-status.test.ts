// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';

vi.mock('@evtivity/database', () => {
  const selectFn = vi.fn();
  const fromFn = vi.fn();
  const whereFn = vi.fn();

  fromFn.mockReturnValue({ where: whereFn });
  selectFn.mockReturnValue({ from: fromFn });

  return {
    db: {
      select: selectFn,
    },
    chargingSessions: {
      status: 'status',
      transactionId: 'transaction_id',
    },
    __mocks: { selectFn, fromFn, whereFn },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
}));

const logger = pino({ level: 'silent' });

function makeCtx(payload: Record<string, unknown>): HandlerContext {
  return {
    stationId: 'CS-001',
    stationDbId: null,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action: 'GetTransactionStatus',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
    },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('GetTransactionStatus handler', () => {
  it('returns ongoingIndicator true for active session', async () => {
    const mod = (await import('@evtivity/database')) as Record<string, unknown>;
    const mocks = mod['__mocks'] as { whereFn: ReturnType<typeof vi.fn> };
    mocks.whereFn.mockResolvedValue([{ status: 'active' }]);

    const { handleGetTransactionStatus } =
      await import('../handlers/v2_1/get-transaction-status.handler.js');

    const ctx = makeCtx({ transactionId: 'tx-123' });
    const response = await handleGetTransactionStatus(ctx);

    expect(response.ongoingIndicator).toBe(true);
    expect(response.messagesInQueue).toBe(false);
  });

  it('returns ongoingIndicator false for completed session', async () => {
    const mod = (await import('@evtivity/database')) as Record<string, unknown>;
    const mocks = mod['__mocks'] as { whereFn: ReturnType<typeof vi.fn> };
    mocks.whereFn.mockResolvedValue([{ status: 'completed' }]);

    const { handleGetTransactionStatus } =
      await import('../handlers/v2_1/get-transaction-status.handler.js');

    const ctx = makeCtx({ transactionId: 'tx-456' });
    const response = await handleGetTransactionStatus(ctx);

    expect(response.ongoingIndicator).toBe(false);
    expect(response.messagesInQueue).toBe(false);
  });

  it('returns ongoingIndicator false when session not found', async () => {
    const mod = (await import('@evtivity/database')) as Record<string, unknown>;
    const mocks = mod['__mocks'] as { whereFn: ReturnType<typeof vi.fn> };
    mocks.whereFn.mockResolvedValue([]);

    const { handleGetTransactionStatus } =
      await import('../handlers/v2_1/get-transaction-status.handler.js');

    const ctx = makeCtx({ transactionId: 'tx-unknown' });
    const response = await handleGetTransactionStatus(ctx);

    expect(response.ongoingIndicator).toBe(false);
    expect(response.messagesInQueue).toBe(false);
  });

  it('returns defaults when no transactionId provided', async () => {
    const { handleGetTransactionStatus } =
      await import('../handlers/v2_1/get-transaction-status.handler.js');

    const ctx = makeCtx({});
    const response = await handleGetTransactionStatus(ctx);

    expect(response.ongoingIndicator).toBe(false);
    expect(response.messagesInQueue).toBe(false);
  });
});
