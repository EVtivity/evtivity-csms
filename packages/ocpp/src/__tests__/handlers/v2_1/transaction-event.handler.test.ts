// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';
import {
  sessionGatedKey,
  sessionPricedKey,
  transactionKey,
} from '../../../server/projection-queue.js';

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
  // The driver's account billing fleet with a credit limit (plan S8): none by default.
  loadDriverAccountCredit: (...args: unknown[]) => accountCreditMock(...args) as unknown,
}));
const accountCreditMock = vi.fn().mockResolvedValue(null);

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

// The cost ceiling the Started projection reserved; null: not linked yet.
const ceilingMock = vi.fn().mockResolvedValue(null);
// The cost ceiling the payment gate reserved for an account session (plan S8).
const accountCeilingMock = vi.fn().mockResolvedValue(null);
// The station got the account ceiling at Started (plan S8, bounded reservation).
const markCeilingSentMock = vi.fn().mockResolvedValue(undefined);
// A grown account ceiling not sent yet; null: nothing new.
const grownCeilingMock = vi.fn().mockResolvedValue(null);
// CostLimitReached: whether the account ceiling was raised above the reached limit.
const raiseCeilingMock = vi.fn().mockResolvedValue(false);
vi.mock('../../../handlers/prepaid-session-limit.js', () => ({
  raiseAccountCeilingAtCostLimit: raiseCeilingMock,
  prepaidSessionCeilingCents: ceilingMock,
  accountSessionCeilingCents: accountCeilingMock,
  markAccountCeilingSent: markCeilingSentMock,
  takeGrownAccountCeiling: grownCeilingMock,
}));

// The station's TxCtrlr.SupportedLimits (E16.FR.12): null means not reported.
const supportedLimitsMock = vi.fn();
vi.mock('../../../handlers/supported-limits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../handlers/supported-limits.js')>()),
  stationSupportedLimits: supportedLimitsMock,
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

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let transactionEventHandlerModule: typeof import('../../../handlers/v2_1/transaction-event.handler.js');
let prepaidModule: typeof import('../../../authorization/prepaid.js');
beforeAll(async () => {
  transactionEventHandlerModule =
    await import('../../../handlers/v2_1/transaction-event.handler.js');
  prepaidModule = await import('../../../authorization/prepaid.js');
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  whereResult = [];
  insertValuesFn.mockResolvedValue(undefined);
  findLimitMock.mockResolvedValue(null);
  supportedLimitsMock.mockResolvedValue(null);
  costMock.mockResolvedValue(null);
  settledMock.mockResolvedValue(true);
  waitForSignalMock.mockResolvedValue(true);
  accountCreditMock.mockResolvedValue(null);
  accountCeilingMock.mockResolvedValue(null);
  markCeilingSentMock.mockResolvedValue(undefined);
  grownCeilingMock.mockResolvedValue(null);
  raiseCeilingMock.mockReset();
  raiseCeilingMock.mockResolvedValue(false);
});

describe('v2_1 TransactionEvent handler', () => {
  it('publishes a normalized ocpp.TransactionEvent for a Started event', async () => {
    const { handleTransactionEvent } = transactionEventHandlerModule;
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

  it('passes the remoteStartId of the event after a remote start (F01.FR.25)', async () => {
    const { handleTransactionEvent } = transactionEventHandlerModule;
    const { ctx, publishMock } = makeCtx({
      eventType: 'Updated',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'RemoteStart',
      seqNo: 1,
      transactionInfo: { transactionId: 'tx-3', chargingState: 'EVConnected', remoteStartId: 42 },
    });
    await handleTransactionEvent(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ remoteStartId: 42 }) as unknown,
      }),
    );
  });

  it('defaults evseId to 0 when no evse is present', async () => {
    const { handleTransactionEvent } = transactionEventHandlerModule;
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
    const { handleTransactionEvent } = transactionEventHandlerModule;
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
        // The station's chargingState decides idle, not the meter fallbacks (JB-1).
        chargingState: 'Charging',
        source: 'TransactionEvent',
      },
    });
  });

  it('publishes ocpp.MeterValues without chargingState when the event carries none', async () => {
    const meterValue = [{ timestamp: '2026-06-04T00:00:00Z', sampledValue: [{ value: 10 }] }];
    const { handleTransactionEvent } = transactionEventHandlerModule;
    const { ctx, publishMock } = makeCtx({
      eventType: 'Updated',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'MeterValuePeriodic',
      seqNo: 3,
      transactionInfo: { transactionId: 'tx-3' },
      evse: { id: 1 },
      meterValue,
    });
    await handleTransactionEvent(ctx);

    const meterEvent = publishMock.mock.calls
      .map((c: unknown[]) => c[0] as { eventType: string; payload: Record<string, unknown> })
      .find((e) => e.eventType === 'ocpp.MeterValues');
    expect(meterEvent?.payload).not.toHaveProperty('chargingState');
  });

  it('passes the reported connector on the transaction event', async () => {
    const { handleTransactionEvent } = transactionEventHandlerModule;
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
    const { handleTransactionEvent } = transactionEventHandlerModule;
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
    const { handleTransactionEvent } = transactionEventHandlerModule;
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
    const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Blocked' } });
    });

    it('returns Blocked for a revoked token', async () => {
      whereResult = [
        { id: 'dtk_4', driverId: 'drv_4', isActive: true, expiresAt: null, revokedAt: new Date() },
      ];
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Expired' } });
    });

    it('accepts with groupIdToken when no driver_tokens row exists', async () => {
      whereResult = [];
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(startedWithToken());
      const response = await handleTransactionEvent(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
    });

    it('logs an authorize attempt only on Started events', async () => {
      whereResult = [
        { id: 'dtk_6', driverId: 'drv_6', isActive: true, expiresAt: null, revokedAt: null },
      ];
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { rememberPrepaidAuthorization, clearPrepaidAuthorizations } = prepaidModule;
      clearPrepaidAuthorizations();
      const authorizedAt = rememberPrepaidAuthorization('CS-001', 'PREPAID-1');
      whereResult = prepaidRow(1234);
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { clearPrepaidAuthorizations } = prepaidModule;
      clearPrepaidAuthorizations();
      whereResult = prepaidRow(500);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(event('Started'));

      const response = await handleTransactionEvent(ctx);
      const info = response['idTokenInfo'] as Record<string, unknown>;

      expect(Math.abs(Date.parse(info['cacheExpiryDateTime'] as string) - Date.now())).toBeLessThan(
        5_000,
      );
    });

    it('omits transactionLimit on the Ended event', async () => {
      whereResult = prepaidRow(1234);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx({ ...event('Ended'), triggerReason: 'StopAuthorized' });

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toBeUndefined();
    });

    it('answers NoCredit without a limit when the balance is not positive', async () => {
      whereResult = prepaidRow(0);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(event('Started'));

      const response = await handleTransactionEvent(ctx);
      const info = response['idTokenInfo'] as Record<string, unknown>;

      expect(info['status']).toBe('NoCredit');
      expect(info['groupIdToken']).toBeUndefined();
      expect(info['cacheExpiryDateTime']).toBeDefined();
      expect(response['transactionLimit']).toBeUndefined();
    });
  });

  describe('fleet credit limit of an account session (plan S8)', () => {
    const accountRow = [
      {
        id: 'dtk_acc',
        driverId: 'drv_acc',
        isActive: true,
        expiresAt: null,
        revokedAt: null,
        prepaidBalanceCents: null,
      },
    ];
    const event = (eventType: string) => ({
      eventType,
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-acc', chargingState: 'Charging' },
      idToken: { idToken: 'ACCOUNT-1', type: 'ISO14443' },
    });

    beforeEach(() => {
      whereResult = accountRow;
      accountCreditMock.mockResolvedValue({ fleetId: 'flt_1', remainingCents: 5000 });
    });

    it('sends the reserved ceiling as transactionLimit.maxCost once the gate ran', async () => {
      accountCeilingMock.mockResolvedValue(1250);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(event('Started'));

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toEqual({ maxCost: 12.5 });
      expect((response['idTokenInfo'] as Record<string, unknown>)['status']).toBe('Accepted');
      expect(accountCreditMock).toHaveBeenCalledWith({}, 'drv_acc');
      expect(waitForSignalMock).toHaveBeenCalledWith(sessionGatedKey('CS-001', 'tx-acc'), 5000);
      expect(accountCeilingMock).toHaveBeenCalledWith('CS-001', 'tx-acc');
      // Recorded as sent, so a grown ceiling follows on a later response.
      expect(markCeilingSentMock).toHaveBeenCalledWith('CS-001', 'tx-acc', 1250);
    });

    it('records no sent ceiling when the station does not support maxCost', async () => {
      accountCeilingMock.mockResolvedValue(1250);
      supportedLimitsMock.mockResolvedValue(new Set(['maxEnergy']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      await handleTransactionEvent(makeCtx(event('Started')).ctx);
      expect(markCeilingSentMock).not.toHaveBeenCalled();
    });

    it('keeps the Started response when recording the sent ceiling fails', async () => {
      accountCeilingMock.mockResolvedValue(1250);
      markCeilingSentMock.mockRejectedValue(new Error('db down'));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const response = await handleTransactionEvent(makeCtx(event('Started')).ctx);
      expect(response['transactionLimit']).toEqual({ maxCost: 12.5 });
    });

    it('sends a grown ceiling once on the next Updated response (E16.FR.02)', async () => {
      grownCeilingMock.mockResolvedValueOnce(2500).mockResolvedValue(null);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const update = { ...event('Updated'), triggerReason: 'MeterValuePeriodic' };
      delete (update as { idToken?: unknown }).idToken;

      const first = await handleTransactionEvent(makeCtx(update).ctx);
      expect(first['transactionLimit']).toEqual({ maxCost: 25 });
      expect(grownCeilingMock).toHaveBeenCalledWith('CS-001', 'tx-acc');

      const second = await handleTransactionEvent(makeCtx(update).ctx);
      expect(second['transactionLimit']).toBeUndefined();
    });

    describe('CostLimitReached (E16.FR.05, the station suspended at its limit)', () => {
      const reached = () => {
        const update = {
          ...event('Updated'),
          triggerReason: 'CostLimitReached',
          transactionInfo: { transactionId: 'tx-acc', chargingState: 'SuspendedEVSE' },
        };
        delete (update as { idToken?: unknown }).idToken;
        return update;
      };

      it('raises the ceiling before the projection runs and sends it in the same response', async () => {
        raiseCeilingMock.mockResolvedValue(true);
        grownCeilingMock.mockResolvedValueOnce(3000);
        const { handleTransactionEvent } = transactionEventHandlerModule;
        const { ctx, publishMock } = makeCtx(reached());

        const response = await handleTransactionEvent(ctx);

        expect(raiseCeilingMock).toHaveBeenCalledWith('CS-001', 'tx-acc');
        // The station resumes at the raised limit (E16 scenario 2, step 4a).
        expect(response['transactionLimit']).toEqual({ maxCost: 30 });
        // The projection learns that the ceiling grew, so it does not claim the session.
        const [published] = publishMock.mock.calls[0] as [{ payload: Record<string, unknown> }];
        expect(published.payload['accountCeilingRaised']).toBe(true);
        expect(raiseCeilingMock.mock.invocationCallOrder[0]).toBeLessThan(
          publishMock.mock.invocationCallOrder[0] ?? 0,
        );
      });

      it('marks nothing when the fleet has no credit left', async () => {
        const { handleTransactionEvent } = transactionEventHandlerModule;
        const { ctx, publishMock } = makeCtx(reached());

        const response = await handleTransactionEvent(ctx);

        expect(response['transactionLimit']).toBeUndefined();
        const [published] = publishMock.mock.calls[0] as [{ payload: Record<string, unknown> }];
        expect(published.payload).not.toHaveProperty('accountCeilingRaised');
      });

      it('marks nothing when raising fails (the projection claims the session)', async () => {
        raiseCeilingMock.mockRejectedValue(new Error('db down'));
        const { handleTransactionEvent } = transactionEventHandlerModule;
        const { ctx, publishMock } = makeCtx(reached());

        await handleTransactionEvent(ctx);

        const [published] = publishMock.mock.calls[0] as [{ payload: Record<string, unknown> }];
        expect(published.payload).not.toHaveProperty('accountCeilingRaised');
      });

      it('raises nothing on an Ended transaction (E16.FR.06) or another trigger', async () => {
        const { handleTransactionEvent } = transactionEventHandlerModule;
        await handleTransactionEvent(
          makeCtx({ ...event('Ended'), triggerReason: 'CostLimitReached' }).ctx,
        );
        await handleTransactionEvent(
          makeCtx({ ...event('Updated'), triggerReason: 'MeterValuePeriodic' }).ctx,
        );
        expect(raiseCeilingMock).not.toHaveBeenCalled();
      });
    });

    it('sends no grown ceiling when its lookup fails', async () => {
      grownCeilingMock.mockRejectedValue(new Error('db down'));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const response = await handleTransactionEvent(makeCtx(event('Updated')).ctx);
      expect(response['transactionLimit']).toBeUndefined();
    });

    it('looks for a grown ceiling only on Updated', async () => {
      accountCeilingMock.mockResolvedValue(1250);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      await handleTransactionEvent(makeCtx(event('Started')).ctx);
      await handleTransactionEvent(makeCtx(event('Ended')).ctx);
      expect(grownCeilingMock).not.toHaveBeenCalled();
    });

    it('answers NoCredit without a limit when the reserved ceiling is 0', async () => {
      accountCeilingMock.mockResolvedValue(0);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(event('Started'));

      const response = await handleTransactionEvent(ctx);
      const info = response['idTokenInfo'] as Record<string, unknown>;

      expect(info['status']).toBe('NoCredit');
      expect(info['groupIdToken']).toBeUndefined();
      expect(response['transactionLimit']).toBeUndefined();
    });

    it('sends no limit when the ceiling is not known (gate timeout or lookup failure)', async () => {
      waitForSignalMock.mockResolvedValue(false);
      settledMock.mockResolvedValue(false);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const first = await handleTransactionEvent(makeCtx(event('Started')).ctx);
      expect(first['transactionLimit']).toBeUndefined();
      expect(accountCeilingMock).not.toHaveBeenCalled();

      waitForSignalMock.mockResolvedValue(true);
      accountCeilingMock.mockRejectedValue(new Error('db down'));
      const second = await handleTransactionEvent(makeCtx(event('Started')).ctx);
      expect(second['transactionLimit']).toBeUndefined();
      expect((second['idTokenInfo'] as Record<string, unknown>)['status']).toBe('Accepted');
    });

    it('sends no account limit on Updated and reads no fleet credit there', async () => {
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const response = await handleTransactionEvent(makeCtx(event('Updated')).ctx);
      expect(response['transactionLimit']).toBeUndefined();
      expect(accountCreditMock).not.toHaveBeenCalled();
    });

    it('waits for no gate for a driver without a limited account fleet', async () => {
      accountCreditMock.mockResolvedValue(null);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const response = await handleTransactionEvent(makeCtx(event('Started')).ctx);
      expect(response['transactionLimit']).toBeUndefined();
      expect(accountCeilingMock).not.toHaveBeenCalled();
    });

    it('sends only the limits the station supports (E16.FR.12)', async () => {
      accountCeilingMock.mockResolvedValue(1250);
      supportedLimitsMock.mockResolvedValue(new Set(['maxEnergy']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const response = await handleTransactionEvent(makeCtx(event('Started')).ctx);
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(directPayment('Started'));

      const response = await handleTransactionEvent(ctx);

      expect(findLimitMock).toHaveBeenCalledWith('CS-001', 'PSP-REF-1');
      expect(response['transactionLimit']).toEqual({ maxEnergy: 20000, maxCost: 50 });
      expect((response['idTokenInfo'] as Record<string, unknown>)['status']).toBe('Accepted');
    });

    it('does not look up a limit on Updated events', async () => {
      whereResult = [];
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(directPayment('Updated'));

      const response = await handleTransactionEvent(ctx);

      expect(findLimitMock).not.toHaveBeenCalled();
      expect(response['transactionLimit']).toBeUndefined();
    });

    it('responds without a limit when the lookup fails', async () => {
      whereResult = [];
      findLimitMock.mockRejectedValue(new Error('db down'));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(directPayment('Started'));

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toBeUndefined();
      expect((response['idTokenInfo'] as Record<string, unknown>)['status']).toBe('Accepted');
    });
  });

  describe('TxCtrlr.SupportedLimits (E16.FR.12)', () => {
    const directPayment = {
      eventType: 'Started',
      timestamp: '2026-06-04T00:00:00Z',
      triggerReason: 'RemoteStart',
      seqNo: 0,
      transactionInfo: { transactionId: 'tx-adhoc', chargingState: 'Charging' },
      evse: { id: 2 },
      idToken: { idToken: 'PSP-REF-1', type: 'DirectPayment' },
    };
    const prepaidStart = {
      ...directPayment,
      triggerReason: 'Authorized',
      idToken: { idToken: 'PREPAID-1', type: 'ISO14443' },
    };
    const prepaidRow = [
      {
        id: 'dtk_pp',
        driverId: 'drv_pp',
        isActive: true,
        expiresAt: null,
        revokedAt: null,
        prepaidBalanceCents: 1234,
      },
    ];

    it('sends only the limits the station supports', async () => {
      whereResult = [];
      findLimitMock.mockResolvedValue({ maxEnergy: 20000, maxCost: 50, maxTime: 3600 });
      supportedLimitsMock.mockResolvedValue(new Set(['maxCost', 'maxTime']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(directPayment);

      const response = await handleTransactionEvent(ctx);

      expect(supportedLimitsMock).toHaveBeenCalledWith({}, 'sta_db_1', 2);
      expect(response['transactionLimit']).toEqual({ maxCost: 50, maxTime: 3600 });
    });

    it('sends the prepaid maxCost to a station that supports it', async () => {
      whereResult = prepaidRow;
      supportedLimitsMock.mockResolvedValue(new Set(['maxCost']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(prepaidStart);

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toEqual({ maxCost: 12.34 });
    });

    it('sends the credit reserved for the session, not the balance', async () => {
      whereResult = prepaidRow;
      ceilingMock.mockResolvedValueOnce(500);
      supportedLimitsMock.mockResolvedValue(new Set(['maxCost']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(prepaidStart);

      const response = await handleTransactionEvent(ctx);

      expect(ceilingMock).toHaveBeenCalledWith('CS-001', expect.any(String), 'dtk_pp');
      expect(response['transactionLimit']).toEqual({ maxCost: 5 });
      expect((response['idTokenInfo'] as Record<string, unknown>)['status']).toBe('Accepted');
    });

    it('still filters the reserved credit by the supported limits (E16.FR.12)', async () => {
      whereResult = prepaidRow;
      ceilingMock.mockResolvedValueOnce(500);
      supportedLimitsMock.mockResolvedValue(new Set(['maxEnergy']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(prepaidStart);

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toBeUndefined();
    });

    it('answers NoCredit without a limit when no credit is left for the session', async () => {
      whereResult = prepaidRow;
      ceilingMock.mockResolvedValueOnce(0);
      supportedLimitsMock.mockResolvedValue(new Set(['maxCost']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(prepaidStart);

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toBeUndefined();
      const info = response['idTokenInfo'] as Record<string, unknown>;
      expect(info['status']).toBe('NoCredit');
      expect(typeof info['cacheExpiryDateTime']).toBe('string');
    });

    it('sends the balance and warns when the ceiling lookup fails', async () => {
      whereResult = prepaidRow;
      ceilingMock.mockRejectedValueOnce(new Error('db down'));
      supportedLimitsMock.mockResolvedValue(new Set(['maxCost']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(prepaidStart);
      const warn = vi.spyOn(ctx.logger, 'warn');

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toEqual({ maxCost: 12.34 });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: expect.any(String) }),
        expect.stringContaining('Prepaid session ceiling lookup failed'),
      );
    });

    it('omits the prepaid maxCost for a station that does not support it', async () => {
      whereResult = prepaidRow;
      supportedLimitsMock.mockResolvedValue(new Set(['maxEnergy', 'maxTime']));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(prepaidStart);

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toBeUndefined();
      // The token is still accepted: the CSMS caps and stops the session itself.
      expect((response['idTokenInfo'] as Record<string, unknown>)['status']).toBe('Accepted');
    });

    it('omits every limit for a station that reported an empty list', async () => {
      whereResult = [];
      findLimitMock.mockResolvedValue({ maxEnergy: 20000, maxCost: 50 });
      supportedLimitsMock.mockResolvedValue(new Set());
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(directPayment);

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toBeUndefined();
    });

    it('sends the whole limit when the station has not reported the variable', async () => {
      whereResult = [];
      findLimitMock.mockResolvedValue({ maxEnergy: 20000, maxCost: 50 });
      supportedLimitsMock.mockResolvedValue(null);
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(directPayment);

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toEqual({ maxEnergy: 20000, maxCost: 50 });
    });

    it('sends the whole limit when the lookup fails', async () => {
      whereResult = prepaidRow;
      supportedLimitsMock.mockRejectedValue(new Error('db down'));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(prepaidStart);

      const response = await handleTransactionEvent(ctx);

      expect(response['transactionLimit']).toEqual({ maxCost: 12.34 });
    });

    it('does not look up the supported limits when no limit is sent', async () => {
      whereResult = [];
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(directPayment);

      await handleTransactionEvent(ctx);

      expect(supportedLimitsMock).not.toHaveBeenCalled();
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx, publishMock } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response['totalCost']).toBe(0);
      const payload = (publishMock.mock.calls[0]?.[0] as { payload: Record<string, unknown> })
        .payload;
      expect(payload['finalCostCents']).toBeUndefined();
    });

    it('passes the end reasons of an EVConnectTimeout end to the cost lookup (C20.FR.03)', async () => {
      costMock.mockResolvedValue({ totalCostCents: 0, calculated: false });
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
    });

    it('omits totalCost when the station calculates the cost (costDetails, TC_E_108)', async () => {
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
      expect(costMock).not.toHaveBeenCalled();
    });

    it('omits totalCost when the cost lookup fails', async () => {
      costMock.mockRejectedValue(new Error('db down'));
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(ended());

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
    });

    it('returns the running cost on Updated without meterStop or finalCostCents', async () => {
      costMock.mockResolvedValue({ totalCostCents: 450, calculated: true });
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
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
      const { handleTransactionEvent } = transactionEventHandlerModule;
      const { ctx } = makeCtx(ended({ eventType: 'Started', meterValue: undefined }));

      const response = await handleTransactionEvent(ctx);

      expect(response).not.toHaveProperty('totalCost');
      expect(costMock).not.toHaveBeenCalled();
    });
  });
});
