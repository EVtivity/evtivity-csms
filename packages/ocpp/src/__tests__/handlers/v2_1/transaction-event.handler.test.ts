// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

let whereResult: Record<string, unknown>[] | Error;
const whereFn = vi.fn((): Promise<Record<string, unknown>[]> => {
  if (whereResult instanceof Error) return Promise.reject(whereResult);
  return Promise.resolve(whereResult);
});
const fromFn = vi.fn(() => ({ where: whereFn }));
const selectFn = vi.fn(() => ({ from: fromFn }));
const insertValuesFn = vi.fn().mockResolvedValue(undefined);

vi.mock('@evtivity/database', () => ({
  db: { select: selectFn, insert: vi.fn(() => ({ values: insertValuesFn })) },
  driverTokens: {
    id: 'id',
    driverId: 'driver_id',
    isActive: 'is_active',
    idToken: 'id_token',
    tokenType: 'token_type',
    expiresAt: 'expires_at',
    revokedAt: 'revoked_at',
  },
  authorizeAttempts: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
}));

const logger = pino({ level: 'silent' });

function makeCtx(payload: Record<string, unknown>): {
  ctx: HandlerContext;
  publishMock: ReturnType<typeof vi.fn>;
} {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const ctx: HandlerContext = {
    stationId: 'CS-001',
    stationDbId: 'sta_db_1',
    session: {
      stationId: 'CS-001',
      stationDbId: 'sta_db_1',
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action: 'TransactionEvent',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

beforeEach(() => {
  vi.clearAllMocks();
  whereResult = [];
  insertValuesFn.mockResolvedValue(undefined);
});

describe('v2_1 TransactionEvent handler', () => {
  it('publishes a normalized ocpp.TransactionEvent for a Started event', async () => {
    const { handleTransactionEvent } =
      await import('../../../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx({
      eventType: 'Started',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-1', chargingState: 'Charging' },
      evse: { id: 2 },
      reservationId: 7,
    });
    const response = await handleTransactionEvent(ctx);

    expect(response).toEqual({});
    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.TransactionEvent',
      aggregateType: 'Transaction',
      aggregateId: 'tx-1',
      payload: {
        stationId: 'CS-001',
        stationDbId: 'sta_db_1',
        eventType: 'Started',
        triggerReason: 'Authorized',
        seqNo: 0,
        transactionId: 'tx-1',
        chargingState: 'Charging',
        stoppedReason: undefined,
        timestamp: '2026-06-04T00:00:00Z',
        idToken: undefined,
        tokenType: undefined,
        evseId: 2,
        reservationId: 7,
      },
    });
  });

  it('defaults evseId to 0 when no evse is present', async () => {
    const { handleTransactionEvent } =
      await import('../../../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx({
      eventType: 'Updated',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'MeterValuePeriodic',
      seqNo: 5,
      transactionInfo: { transactionId: 'tx-2', chargingState: 'Charging' },
    });
    await handleTransactionEvent(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ evseId: 0 }) as unknown,
      }),
    );
  });

  it('publishes ocpp.MeterValues when meterValue is present', async () => {
    const meterValue = [{ timestamp: '2026-06-04T00:00:00Z', sampledValue: [{ value: 10 }] }];
    const { handleTransactionEvent } =
      await import('../../../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx({
      eventType: 'Updated',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'MeterValuePeriodic',
      seqNo: 3,
      transactionInfo: { transactionId: 'tx-3', chargingState: 'Charging' },
      evse: { id: 1 },
      meterValue,
    });
    await handleTransactionEvent(ctx);

    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.MeterValues',
      aggregateType: 'EVSE',
      aggregateId: 'CS-001',
      payload: {
        stationId: 'CS-001',
        stationDbId: 'sta_db_1',
        evseId: 1,
        meterValues: meterValue,
        source: 'TransactionEvent',
      },
    });
  });

  it('does not publish MeterValues for an empty meterValue array', async () => {
    const { handleTransactionEvent } =
      await import('../../../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx({
      eventType: 'Updated',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'MeterValuePeriodic',
      seqNo: 4,
      transactionInfo: { transactionId: 'tx-4', chargingState: 'Charging' },
      meterValue: [],
    });
    await handleTransactionEvent(ctx);

    const meterPublishCalls = publishMock.mock.calls.filter(
      (c) => (c[0] as { eventType: string }).eventType === 'ocpp.MeterValues',
    );
    expect(meterPublishCalls).toHaveLength(0);
  });

  it('forwards stoppedReason on an Ended event (EVConnectTimeout)', async () => {
    const { handleTransactionEvent } =
      await import('../../../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx({
      eventType: 'Ended',
      timestamp: '2026-06-04T00:05:00Z',
      triggerReason: 'EVConnectTimeout',
      seqNo: 9,
      transactionInfo: {
        transactionId: 'tx-5',
        chargingState: 'EVConnected',
        stoppedReason: 'Timeout',
      },
      evse: { id: 1 },
    });
    await handleTransactionEvent(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          eventType: 'Ended',
          triggerReason: 'EVConnectTimeout',
          stoppedReason: 'Timeout',
          chargingState: 'EVConnected',
        }) as unknown,
      }),
    );
  });

  describe('idTokenInfo (mid-session re-authorization)', () => {
    const startedWithToken = (overrides: Record<string, unknown> = {}) => ({
      eventType: 'Started',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-tok', chargingState: 'Charging' },
      idToken: { idToken: 'rfid-1', type: 'ISO14443' },
      ...overrides,
    });

    it('accepts an active token and returns groupIdToken + cacheExpiryDateTime', async () => {
      const expiresAt = new Date(Date.now() + 86_400_000);
      whereResult = [
        { id: 'dtk_1', driverId: 'drv_1', isActive: true, expiresAt, revokedAt: null },
      ];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({
        idTokenInfo: {
          status: 'Accepted',
          groupIdToken: { idToken: 'rfid-1', type: 'ISO14443' },
          cacheExpiryDateTime: expiresAt.toISOString(),
        },
      });
    });

    it('accepts an active token with no expiry (omits cacheExpiryDateTime)', async () => {
      whereResult = [
        { id: 'dtk_2', driverId: 'drv_2', isActive: true, expiresAt: null, revokedAt: null },
      ];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({
        idTokenInfo: {
          status: 'Accepted',
          groupIdToken: { idToken: 'rfid-1', type: 'ISO14443' },
        },
      });
    });

    it('returns Blocked for an inactive token', async () => {
      whereResult = [
        { id: 'dtk_3', driverId: 'drv_3', isActive: false, expiresAt: null, revokedAt: null },
      ];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Blocked' } });
    });

    it('returns Blocked for a revoked token', async () => {
      whereResult = [
        { id: 'dtk_4', driverId: 'drv_4', isActive: true, expiresAt: null, revokedAt: new Date() },
      ];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Blocked' } });
    });

    it('returns Expired for a token past its expiry', async () => {
      whereResult = [
        {
          id: 'dtk_5',
          driverId: 'drv_5',
          isActive: true,
          expiresAt: new Date(Date.now() - 1000),
          revokedAt: null,
        },
      ];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Expired' } });
    });

    it('accepts with groupIdToken when no driver_tokens row exists', async () => {
      whereResult = [];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(
        startedWithToken({ idToken: { idToken: 'central-1', type: 'Central' } }),
      );
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({
        idTokenInfo: {
          status: 'Accepted',
          groupIdToken: { idToken: 'central-1', type: 'Central' },
        },
      });
    });

    it('accepts (status only) when the token lookup throws', async () => {
      whereResult = new Error('db down');
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
    });

    it('logs an authorize attempt only on Started events', async () => {
      whereResult = [
        { id: 'dtk_6', driverId: 'drv_6', isActive: true, expiresAt: null, revokedAt: null },
      ];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(startedWithToken());
      await handleTransactionEvent(ctx);
      // logAuthorizeAttempt is fire-and-forget; allow the microtask to flush
      await Promise.resolve();
      expect(insertValuesFn).toHaveBeenCalledTimes(1);
    });

    it('does not log an authorize attempt on Updated events', async () => {
      whereResult = [
        { id: 'dtk_7', driverId: 'drv_7', isActive: true, expiresAt: null, revokedAt: null },
      ];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(startedWithToken({ eventType: 'Updated' }));
      await handleTransactionEvent(ctx);
      await Promise.resolve();
      expect(insertValuesFn).not.toHaveBeenCalled();
    });
  });
});
