// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';
import * as databaseModule from '@evtivity/database';
import * as getTransactionStatusHandlerModule from '../handlers/v2_1/get-transaction-status.handler.js';

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
      stationId: 'station_id',
      transactionId: 'transaction_id',
    },
    __mocks: { selectFn, fromFn, whereFn },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
}));

const logger = pino({ level: 'silent' });

function makeCtx(
  payload: Record<string, unknown>,
  stationDbId: string | null = 'sta_000000000001',
): HandlerContext {
  return {
    stationId: 'CS-001',
    stationDbId,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action: 'GetTransactionStatus',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      drain: vi.fn(),
      track: vi.fn(),
    },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('GetTransactionStatus handler', () => {
  it('returns ongoingIndicator true for active session', async () => {
    const mod = databaseModule as Record<string, unknown>;
    const mocks = mod['__mocks'] as { whereFn: ReturnType<typeof vi.fn> };
    mocks.whereFn.mockResolvedValue([{ status: 'active' }]);

    const { handleGetTransactionStatus } = getTransactionStatusHandlerModule;

    const ctx = makeCtx({ transactionId: 'tx-123' });
    const response = await handleGetTransactionStatus(ctx);

    expect(response.ongoingIndicator).toBe(true);
    expect(response.messagesInQueue).toBe(false);
    // A transactionId is unique per station only: the lookup is scoped by it.
    expect(mocks.whereFn).toHaveBeenLastCalledWith({
      type: 'and',
      conditions: [
        { type: 'eq', a: 'station_id', b: 'sta_000000000001' },
        { type: 'eq', a: 'transaction_id', b: 'tx-123' },
      ],
    });
  });

  it('returns ongoingIndicator false for completed session', async () => {
    const mod = databaseModule as Record<string, unknown>;
    const mocks = mod['__mocks'] as { whereFn: ReturnType<typeof vi.fn> };
    mocks.whereFn.mockResolvedValue([{ status: 'completed' }]);

    const { handleGetTransactionStatus } = getTransactionStatusHandlerModule;

    const ctx = makeCtx({ transactionId: 'tx-456' });
    const response = await handleGetTransactionStatus(ctx);

    expect(response.ongoingIndicator).toBe(false);
    expect(response.messagesInQueue).toBe(false);
  });

  it('returns ongoingIndicator false when session not found', async () => {
    const mod = databaseModule as Record<string, unknown>;
    const mocks = mod['__mocks'] as { whereFn: ReturnType<typeof vi.fn> };
    mocks.whereFn.mockResolvedValue([]);

    const { handleGetTransactionStatus } = getTransactionStatusHandlerModule;

    const ctx = makeCtx({ transactionId: 'tx-unknown' });
    const response = await handleGetTransactionStatus(ctx);

    expect(response.ongoingIndicator).toBe(false);
    expect(response.messagesInQueue).toBe(false);
  });

  it('returns defaults when no transactionId provided', async () => {
    const { handleGetTransactionStatus } = getTransactionStatusHandlerModule;

    const ctx = makeCtx({});
    const response = await handleGetTransactionStatus(ctx);

    expect(response.ongoingIndicator).toBe(false);
    expect(response.messagesInQueue).toBe(false);
  });

  it('returns defaults for an unregistered station without a lookup', async () => {
    const mod = databaseModule as Record<string, unknown>;
    const mocks = mod['__mocks'] as { whereFn: ReturnType<typeof vi.fn> };
    mocks.whereFn.mockClear();

    const { handleGetTransactionStatus } = getTransactionStatusHandlerModule;

    const response = await handleGetTransactionStatus(makeCtx({ transactionId: 'tx-1' }, null));

    expect(response.ongoingIndicator).toBe(false);
    expect(mocks.whereFn).not.toHaveBeenCalled();
  });
});
