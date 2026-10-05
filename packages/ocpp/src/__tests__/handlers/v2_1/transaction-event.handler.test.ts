// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';
import { sessionPricedKey, transactionKey } from '../../../server/projection-queue.js';

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
    prepaidBalanceCents: 'prepaid_balance_cents',
  },
  authorizeAttempts: {},
  client: {},
}));

const costMock = vi.fn();
vi.mock('../../../server/session-cost.js', () => ({
  transactionCostAt: costMock,
}));

const settledMock = vi.fn();
const waitForSignalMock = vi.fn();
vi.mock('../../../server/projection-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/projection-queue.js')>()),
  projectionQueueFor: () => ({ settled: settledMock, waitForSignal: waitForSignalMock }),
}));

const findLimitMock = vi.fn();
vi.mock('../../../handlers/ad-hoc-payment-limit.js', () => ({
  findAdHocTransactionLimit: findLimitMock,
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
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action: 'TransactionEvent',
    protocolVersion: 'ocpp2.1',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn(), drain: vi.fn(), track: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

beforeEach(() => {
  vi.clearAllMocks();
  whereResult = [];
  insertValuesFn.mockResolvedValue(undefined);
  findLimitMock.mockResolvedValue(null);
  costMock.mockResolvedValue(null);
  settledMock.mockResolvedValue(true);
  waitForSignalMock.mockResolvedValue(true);
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
        transactionId: 'tx-3',
        source: 'TransactionEvent',
      },
    });
  });

  it('passes the reported connector on the transaction event', async () => {
    const { handleTransactionEvent } =
      await import('../../../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx({
      eventType: 'Started',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-conn' },
      evse: { id: 2, connectorId: 1 },
    });
    await handleTransactionEvent(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.TransactionEvent',
        payload: expect.objectContaining({ evseId: 2, connectorId: 1 }) as unknown,
      }),
    );
  });

  it('keeps the transactionId on MeterValues when no evse is present', async () => {
    const meterValue = [{ timestamp: '2026-06-04T00:00:00Z', sampledValue: [{ value: 7 }] }];
    const { handleTransactionEvent } =
      await import('../../../handlers/v2_1/transaction-event.handler.js');
    const { ctx, publishMock } = makeCtx({
      eventType: 'Updated',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'MeterValuePeriodic',
      seqNo: 3,
      transactionInfo: { transactionId: 'tx-no-evse', chargingState: 'Charging' },
      meterValue,
    });
    await handleTransactionEvent(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.MeterValues',
        payload: expect.objectContaining({ evseId: 0, transactionId: 'tx-no-evse' }) as unknown,
      }),
    );
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

    it('accepts an active token whose row has a null driverId', async () => {
      whereResult = [
        { id: 'dtk_nd', driverId: null, isActive: true, expiresAt: null, revokedAt: null },
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
  describe('prepaid tokens (C17)', () => {
    const prepaidRow = (prepaidBalanceCents: number) => [
      {
        id: 'dtk_pp',
        driverId: 'drv_pp',
        isActive: true,
        expiresAt: null,
        revokedAt: null,
        prepaidBalanceCents,
      },
    ];
    const event = (eventType: string) => ({
      eventType,
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-pp', chargingState: 'Charging' },
      idToken: { idToken: 'PREPAID-1', type: 'ISO14443' },
    });

    it('returns the credit as transactionLimit.maxCost with the Authorize cacheExpiryDateTime', async () => {
      const { rememberPrepaidAuthorization, clearPrepaidAuthorizations } =
        await import('../../../handlers/prepaid.js');
      clearPrepaidAuthorizations();
      const authorizedAt = rememberPrepaidAuthorization('CS-001', 'PREPAID-1');
      whereResult = prepaidRow(1234);
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(event('Started'));

      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({
        transactionLimit: { maxCost: 12.34 },
        idTokenInfo: {
          status: 'Accepted',
          groupIdToken: { idToken: 'PREPAID-1', type: 'ISO14443' },
          cacheExpiryDateTime: authorizedAt,
        },
      });
      expect(findLimitMock).not.toHaveBeenCalled();
    });

    it('sets cacheExpiryDateTime to now when the station did not authorize first', async () => {
      const { clearPrepaidAuthorizations } = await import('../../../handlers/prepaid.js');
      clearPrepaidAuthorizations();
      whereResult = prepaidRow(500);
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(event('Started'));

      const response = await handleTransactionEvent(ctx);
      const info = response['idTokenInfo'] as Record<string, unknown>;

      expect(Math.abs(Date.parse(info['cacheExpiryDateTime'] as string) - Date.now())).toBeLessThan(
        5_000,
      );
    });

    it('omits transactionLimit on the Ended event', async () => {
      whereResult = prepaidRow(1234);
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx({ ...event('Ended'), triggerReason: 'StopAuthorized' });

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toBeUndefined();
    });

    it('answers NoCredit without a limit when the balance is not positive', async () => {
      whereResult = prepaidRow(0);
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(event('Started'));

      const response = await handleTransactionEvent(ctx);
      const info = response['idTokenInfo'] as Record<string, unknown>;

      expect(info['status']).toBe('NoCredit');
      expect(info['groupIdToken']).toBeUndefined();
      expect(info['cacheExpiryDateTime']).toBeDefined();
      expect(response['transactionLimit']).toBeUndefined();
    });
  });

  describe('ad hoc payment limit (C24, C25)', () => {
    const directPayment = (eventType: string) => ({
      eventType,
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'RemoteStart',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-adhoc', chargingState: 'Charging' },
      idToken: { idToken: 'PSP-REF-1', type: 'DirectPayment' },
    });

    it('returns the payment limit when the transaction starts', async () => {
      whereResult = [];
      findLimitMock.mockResolvedValue({ maxEnergy: 20000, maxCost: 50 });
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(directPayment('Started'));

      const response = await handleTransactionEvent(ctx);

      expect(findLimitMock).toHaveBeenCalledWith('CS-001', 'PSP-REF-1');
      expect(response['transactionLimit']).toEqual({ maxEnergy: 20000, maxCost: 50 });
      expect((response['idTokenInfo'] as Record<string, unknown>)['status']).toBe('Accepted');
    });

    it('does not look up a limit on Updated events', async () => {
      whereResult = [];
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(directPayment('Updated'));

      const response = await handleTransactionEvent(ctx);

      expect(findLimitMock).not.toHaveBeenCalled();
      expect(response['transactionLimit']).toBeUndefined();
    });

    it('responds without a limit when the lookup fails', async () => {
      whereResult = [];
      findLimitMock.mockRejectedValue(new Error('db down'));
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(directPayment('Started'));

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toBeUndefined();
      expect((response['idTokenInfo'] as Record<string, unknown>)['status']).toBe('Accepted');
    });
  });

  describe('totalCost (central cost calculation, I03.FR.02)', () => {
    const ended = (overrides: Record<string, unknown> = {}) => ({
      eventType: 'Ended',
      timestamp: '2026-06-04T01:00:00Z',
      triggerReason: 'StopAuthorized',
      seqNo: 3,
      transactionInfo: { transactionId: 'tx-cost', stoppedReason: 'Local' },
      meterValue: [
        {
          timestamp: '2026-06-04T01:00:00Z',
          sampledValue: [{ value: 15000.4, context: 'Transaction.End' }],
        },
      ],
      ...overrides,
    });

    it('returns the final cost in major units and passes it and meterStop to the projection', async () => {
      costMock.mockResolvedValue({ totalCostCents: 1234, calculated: true });
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx, publishMock } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response['totalCost']).toBe(12.34);
      expect(settledMock).toHaveBeenCalledWith(
        [transactionKey('CS-001', 'tx-cost'), 'CS-001'],
        5000,
      );
      expect(costMock).toHaveBeenCalledWith(
        {},
        {
          stationId: 'CS-001',
          transactionId: 'tx-cost',
          at: new Date('2026-06-04T01:00:00Z'),
          meterRegisterWh: 15000,
          end: { triggerReason: 'StopAuthorized', stoppedReason: 'Local' },
        },
      );
      expect(publishMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'ocpp.TransactionEvent',
          payload: expect.objectContaining({ meterStop: 15000, finalCostCents: 1234 }) as unknown,
        }),
      );
    });

    it('returns 0.00 for an unbilled session without passing a cost to the projection', async () => {
      costMock.mockResolvedValue({ totalCostCents: 0, calculated: false });
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx, publishMock } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response['totalCost']).toBe(0);
      const payload = (publishMock.mock.calls[0]?.[0] as { payload: Record<string, unknown> })
        .payload;
      expect(payload['finalCostCents']).toBeUndefined();
    });

    it('passes the end reasons of an EVConnectTimeout end to the cost lookup (C20.FR.03)', async () => {
      costMock.mockResolvedValue({ totalCostCents: 0, calculated: false });
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx, publishMock } = makeCtx(
        ended({
          triggerReason: 'EVConnectTimeout',
          transactionInfo: { transactionId: 'tx-cost', stoppedReason: 'Timeout' },
        }),
      );

      const response = await handleTransactionEvent(ctx);

      expect(response['totalCost']).toBe(0);
      expect(costMock).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          end: { triggerReason: 'EVConnectTimeout', stoppedReason: 'Timeout' },
        }),
      );
      const payload = (publishMock.mock.calls[0]?.[0] as { payload: Record<string, unknown> })
        .payload;
      expect(payload['finalCostCents']).toBeUndefined();
    });

    it('omits totalCost when the session is unknown', async () => {
      costMock.mockResolvedValue(null);
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
    });

    it('omits totalCost when the station calculates the cost (costDetails, TC_E_108)', async () => {
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx, publishMock } = makeCtx(
        ended({
          costDetails: {
            totalCost: { currency: 'EUR', typeOfCost: 'NormalCost', total: { inclTax: 2 } },
            totalUsage: { energy: 0, chargingTime: 120, idleTime: 0 },
          },
        }),
      );

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
      expect(costMock).not.toHaveBeenCalled();
      const payload = (publishMock.mock.calls[0]?.[0] as { payload: Record<string, unknown> })
        .payload;
      expect(payload['meterStop']).toBe(15000);
    });

    it('omits totalCost when earlier projections do not finish in time', async () => {
      settledMock.mockResolvedValue(false);
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
      expect(costMock).not.toHaveBeenCalled();
    });

    it('omits totalCost when the cost lookup fails', async () => {
      costMock.mockRejectedValue(new Error('db down'));
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
    });

    it('returns the running cost on Updated without meterStop or finalCostCents', async () => {
      costMock.mockResolvedValue({ totalCostCents: 450, calculated: true });
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx, publishMock } = makeCtx(ended({ eventType: 'Updated' }));

      const response = await handleTransactionEvent(ctx);

      expect(response['totalCost']).toBe(4.5);
      expect(settledMock).toHaveBeenCalledWith(
        [transactionKey('CS-001', 'tx-cost'), 'CS-001'],
        5000,
      );
      expect(costMock).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ transactionId: 'tx-cost', meterRegisterWh: 15000 }),
      );
      expect(costMock.mock.calls[0]?.[1]).not.toHaveProperty('end');
      const payload = (publishMock.mock.calls[0]?.[0] as { payload: Record<string, unknown> })
        .payload;
      expect(payload).not.toHaveProperty('meterStop');
      expect(payload).not.toHaveProperty('finalCostCents');
    });

    it('returns the running cost on Started once the session is priced', async () => {
      costMock.mockResolvedValue({ totalCostCents: 100, calculated: true });
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx, publishMock } = makeCtx(ended({ eventType: 'Started', meterValue: undefined }));

      const response = await handleTransactionEvent(ctx);

      expect(response['totalCost']).toBe(1);
      expect(waitForSignalMock).toHaveBeenCalledWith(sessionPricedKey('CS-001', 'tx-cost'), 5000);
      // The Started event is published before the wait: its projection creates the session.
      expect(publishMock.mock.invocationCallOrder[0]).toBeLessThan(
        waitForSignalMock.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('omits totalCost on Started when the session is not priced in time', async () => {
      waitForSignalMock.mockResolvedValue(false);
      settledMock.mockResolvedValue(false);
      const { handleTransactionEvent } =
        await import('../../../handlers/v2_1/transaction-event.handler.js');
      const { ctx } = makeCtx(ended({ eventType: 'Started', meterValue: undefined }));

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
      expect(costMock).not.toHaveBeenCalled();
    });
  });
});
