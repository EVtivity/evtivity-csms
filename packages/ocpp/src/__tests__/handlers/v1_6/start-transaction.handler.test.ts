// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

const selectFn = vi.fn();
const executeFn = vi.fn();
const insertFn = vi.fn();
const valuesFn = vi.fn();

vi.mock('@evtivity/database', () => {
  insertFn.mockReturnValue({ values: valuesFn });
  valuesFn.mockResolvedValue(undefined);
  return {
    db: { select: selectFn, execute: executeFn, insert: insertFn },
    driverTokens: { id: 'id', driverId: 'driver_id', idToken: 'id_token', isActive: 'is_active' },
    drivers: { id: 'id', isActive: 'is_active' },
    guestSessions: {
      sessionToken: 'session_token',
      status: 'status',
      stationOcppId: 'station_ocpp_id',
    },
    chargingSessions: { id: 'id', tokenId: 'token_id', status: 'status' },
    authorizeAttempts: { __table: 'authorize_attempts' },
    isSiteFreeVendEnabledByStation: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => ({
      type: 'sql',
      raw: strings.join('?'),
    }),
    { raw: (s: string) => ({ type: 'sql-raw', raw: s }) },
  ),
}));

import { handleStartTransaction } from '../../../handlers/v1_6/start-transaction.handler.js';
import { isSiteFreeVendEnabledByStation } from '@evtivity/database';

const logger = pino({ level: 'silent' });

function selectResolving(rows: unknown[]): { from: ReturnType<typeof vi.fn> } {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit })) as ReturnType<typeof vi.fn>;
  (where as unknown as { then?: unknown }).then = (resolve: (v: unknown) => unknown): unknown =>
    resolve(rows);
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

function selectThrowing(err: unknown): { from: ReturnType<typeof vi.fn> } {
  const reject = vi.fn().mockRejectedValue(err);
  const where = vi.fn(() => ({ limit: reject })) as ReturnType<typeof vi.fn>;
  (where as unknown as { then?: unknown }).then = (
    _resolve: (v: unknown) => unknown,
    rejectCb: (e: unknown) => unknown,
  ): unknown => rejectCb(err);
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

function makeCtx(
  payload: Record<string, unknown>,
  overrides?: Partial<HandlerContext>,
): { ctx: HandlerContext; publishMock: ReturnType<typeof vi.fn> } {
  const publishMock = vi.fn().mockResolvedValue(undefined);
  const ctx: HandlerContext = {
    stationId: 'CS-001',
    stationDbId: null,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      ocppProtocol: 'ocpp1.6',
      bootStatus: null,
    },
    messageId: 'msg-1',
    action: 'StartTransaction',
    protocolVersion: 'ocpp1.6',
    payload,
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
    ...overrides,
  };
  return { ctx, publishMock };
}

function lastAttemptRow(): Record<string, unknown> {
  const call = valuesFn.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

function basePayload(idTag: string): Record<string, unknown> {
  return {
    connectorId: 1,
    idTag,
    meterStart: 1000,
    timestamp: '2026-02-15T10:00:00Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertFn.mockReturnValue({ values: valuesFn });
  valuesFn.mockResolvedValue(undefined);
  selectFn.mockReturnValue(selectResolving([]));
  executeFn.mockResolvedValue([{ nextval: '5000' }]);
  vi.mocked(isSiteFreeVendEnabledByStation).mockResolvedValue(false);
});

describe('OCPP 1.6 StartTransaction handler', () => {
  describe('transaction id allocation', () => {
    it('allocates a new id from the sequence when stationDbId is null', async () => {
      executeFn.mockResolvedValue([{ nextval: '5000' }]);
      const { ctx, publishMock } = makeCtx(basePayload('TAG-SEQ'));

      const response = await handleStartTransaction(ctx);

      expect(response.transactionId).toBe(5000);
      // Only the sequence SELECT runs, no UPDATE claim.
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(publishMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'ocpp.TransactionEvent',
          aggregateType: 'Transaction',
          aggregateId: '5000',
          payload: expect.objectContaining({
            eventType: 'Started',
            triggerReason: 'Authorized',
            seqNo: 0,
            transactionId: '5000',
            idToken: 'TAG-SEQ',
            tokenType: 'ISO14443',
            evseId: 1,
            connectorId: 1,
            meterStart: 1000,
            timestamp: '2026-02-15T10:00:00Z',
            stationId: 'CS-001',
          }) as unknown,
        }),
      );
    });

    it('claims a pending session via UPDATE when one exists', async () => {
      executeFn.mockResolvedValueOnce([{ transaction_id: '42' }]);
      const { ctx, publishMock } = makeCtx(basePayload('TAG-CLAIM'), { stationDbId: 'sta_1' });

      const response = await handleStartTransaction(ctx);

      expect(response.transactionId).toBe(42);
      // Only the UPDATE claim runs; no sequence call needed.
      expect(executeFn).toHaveBeenCalledTimes(1);
      expect(publishMock).toHaveBeenCalledWith(expect.objectContaining({ aggregateId: '42' }));
    });

    it('falls back to the sequence when the UPDATE claims no row', async () => {
      executeFn.mockResolvedValueOnce([]).mockResolvedValueOnce([{ nextval: '77' }]);
      const { ctx } = makeCtx(basePayload('TAG-NOCLAIM'), { stationDbId: 'sta_2' });

      const response = await handleStartTransaction(ctx);

      expect(response.transactionId).toBe(77);
      expect(executeFn).toHaveBeenCalledTimes(2);
    });

    it('falls back to the sequence when the claimed transaction_id is not numeric', async () => {
      executeFn
        .mockResolvedValueOnce([{ transaction_id: 'not-a-number' }])
        .mockResolvedValueOnce([{ nextval: '88' }]);
      const { ctx } = makeCtx(basePayload('TAG-NAN'), { stationDbId: 'sta_3' });

      const response = await handleStartTransaction(ctx);

      expect(response.transactionId).toBe(88);
    });

    it('falls back to the sequence when the claimed transaction_id is a float', async () => {
      executeFn
        .mockResolvedValueOnce([{ transaction_id: '3.14' }])
        .mockResolvedValueOnce([{ nextval: '99' }]);
      const { ctx } = makeCtx(basePayload('TAG-FLOAT'), { stationDbId: 'sta_4' });

      const response = await handleStartTransaction(ctx);

      expect(response.transactionId).toBe(99);
    });

    it('falls back to the sequence when the claim row is undefined', async () => {
      executeFn.mockResolvedValueOnce([undefined]).mockResolvedValueOnce([{ nextval: '111' }]);
      const { ctx } = makeCtx(basePayload('TAG-UNDEF'), { stationDbId: 'sta_5' });

      const response = await handleStartTransaction(ctx);

      expect(response.transactionId).toBe(111);
    });

    it('defaults to 1 when the sequence query returns no row', async () => {
      executeFn.mockResolvedValueOnce([]);
      const { ctx } = makeCtx(basePayload('TAG-DEFAULT'));

      const response = await handleStartTransaction(ctx);

      expect(response.transactionId).toBe(1);
    });

    it('uses a timestamp-based id when the sequence query throws', async () => {
      executeFn.mockRejectedValueOnce(new Error('db down'));
      const { ctx } = makeCtx(basePayload('TAG-TS'));

      const response = await handleStartTransaction(ctx);

      expect(typeof response.transactionId).toBe('number');
      expect(Number.isInteger(response.transactionId)).toBe(true);
      expect(response.transactionId as number).toBeGreaterThan(0);
    });

    it('forwards reservationId into the emitted event', async () => {
      const { ctx, publishMock } = makeCtx({ ...basePayload('TAG-RES'), reservationId: 7 });

      await handleStartTransaction(ctx);

      expect(publishMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ reservationId: 7 }) as unknown,
        }),
      );
    });
  });

  describe('free-vend short-circuit', () => {
    it('returns Accepted, logs free_vend, and skips token validation', async () => {
      vi.mocked(isSiteFreeVendEnabledByStation).mockResolvedValue(true);
      const { ctx } = makeCtx(basePayload('FREE-TAG'));

      const response = await handleStartTransaction(ctx);

      expect(response).toEqual({ transactionId: 5000, idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'accepted',
        reason: 'free_vend',
        tokenType: 'ISO14443',
        matchedTokenId: null,
        matchedDriverId: null,
      });
      // No driver_tokens select happens on the free-vend path.
      expect(selectFn).not.toHaveBeenCalled();
    });
  });

  describe('driver_tokens validation matrix', () => {
    it('Accepted with expiryDate for an active future-expiry token', async () => {
      const future = new Date(Date.now() + 86_400_000);
      selectFn
        .mockReturnValueOnce(
          selectResolving([
            {
              id: 'dtk_ok',
              driverId: 'drv_ok',
              isActive: true,
              expiresAt: future,
              revokedAt: null,
            },
          ]),
        )
        .mockReturnValueOnce(selectResolving([])); // concurrent-tx lookup: none
      const { ctx } = makeCtx(basePayload('GOOD-TAG'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({
        status: 'Accepted',
        expiryDate: future.toISOString(),
      });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'accepted',
        matchedTokenId: 'dtk_ok',
        matchedDriverId: 'drv_ok',
      });
    });

    it('Expired when the matched token expiry is in the past', async () => {
      const past = new Date(Date.now() - 60_000);
      selectFn.mockReturnValueOnce(
        selectResolving([
          { id: 'dtk_exp', driverId: 'drv_exp', isActive: true, expiresAt: past, revokedAt: null },
        ]),
      );
      const { ctx } = makeCtx(basePayload('EXP-TAG'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Expired' });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'expired', reason: 'expired_at' });
    });

    it('Blocked when the matched token is inactive/revoked', async () => {
      selectFn.mockReturnValueOnce(
        selectResolving([
          { id: 'dtk_x', driverId: 'drv_x', isActive: false, expiresAt: null, revokedAt: null },
        ]),
      );
      const { ctx } = makeCtx(basePayload('INACT-TAG'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Blocked' });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'blocked',
        reason: 'inactive_or_revoked',
        matchedTokenId: 'dtk_x',
      });
    });
  });

  describe('driver-id fallback (drv_ prefix)', () => {
    it('Accepted for an active driver id', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([])) // driver_tokens empty
        .mockReturnValueOnce(selectResolving([{ id: 'drv_1', isActive: true }])); // drivers
      const { ctx } = makeCtx(basePayload('drv_1'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Accepted' });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'accepted',
        matchedDriverId: 'drv_1',
        matchedTokenId: null,
      });
    });

    it('Blocked for an inactive driver id with driver_inactive reason', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([{ id: 'drv_off', isActive: false }]));
      const { ctx } = makeCtx(basePayload('drv_off'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Blocked' });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'blocked',
        reason: 'driver_inactive',
        matchedDriverId: 'drv_off',
      });
    });

    it('falls through to guest lookup when the drv_ id is unknown', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([])) // driver_tokens
        .mockReturnValueOnce(selectResolving([])) // drivers: not found
        .mockReturnValueOnce(selectResolving([])); // guest_sessions: not found
      const { ctx } = makeCtx(basePayload('drv_missing'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Invalid' });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'unknown', reason: 'token_not_found' });
    });
  });

  describe('guest_sessions fallback', () => {
    it('Invalid when no token, driver, or guest session matches', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([])) // driver_tokens
        .mockReturnValueOnce(selectResolving([])); // guest_sessions
      const { ctx } = makeCtx(basePayload('UNKNOWN'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Invalid' });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'unknown', reason: 'token_not_found' });
    });

    it('Accepted (guest_session reason) when guest session is payment_authorized', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([{ status: 'payment_authorized' }]));
      const { ctx } = makeCtx(basePayload('GUEST-AUTH'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Accepted' });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'accepted', reason: 'guest_session' });
    });

    it('Accepted when guest session is already charging', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([{ status: 'charging' }]));
      const { ctx } = makeCtx(basePayload('GUEST-CHARGING'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Accepted' });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'accepted', reason: 'guest_session' });
    });

    it('Blocked when guest session is in a non-authorized state', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([{ status: 'pending' }]));
      const { ctx } = makeCtx(basePayload('GUEST-PENDING'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'Blocked' });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'blocked', reason: 'guest_pending' });
    });
  });

  describe('fail-open on DB error', () => {
    it('Accepted with db_error outcome when the token query throws', async () => {
      selectFn.mockImplementationOnce(() => {
        throw new Error('connection refused');
      });
      const { ctx } = makeCtx(basePayload('DB-ERR'));

      const response = await handleStartTransaction(ctx);

      // db_error keeps idTagStatus at its 'Accepted' default; matchedTokenId
      // stays null so the concurrent-tx guard is skipped.
      expect(response.idTagInfo).toEqual({ status: 'Accepted' });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'db_error',
        reason: 'db_unreachable',
        matchedTokenId: null,
      });
    });
  });

  describe('concurrent-transaction guard', () => {
    it('ConcurrentTx when the matched token already has an active session', async () => {
      const future = new Date(Date.now() + 86_400_000);
      selectFn
        .mockReturnValueOnce(
          selectResolving([
            {
              id: 'dtk_busy',
              driverId: 'drv_busy',
              isActive: true,
              expiresAt: future,
              revokedAt: null,
            },
          ]),
        )
        .mockReturnValueOnce(selectResolving([{ id: 'ses_active' }]));
      const { ctx } = makeCtx(basePayload('BUSY-TAG'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({ status: 'ConcurrentTx' });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'concurrent_tx',
        reason: 'concurrent_session ses_active',
        matchedTokenId: 'dtk_busy',
      });
    });

    it('stays Accepted and warns when the concurrent-tx lookup throws', async () => {
      const future = new Date(Date.now() + 86_400_000);
      selectFn
        .mockReturnValueOnce(
          selectResolving([
            { id: 'dtk_w', driverId: 'drv_w', isActive: true, expiresAt: future, revokedAt: null },
          ]),
        )
        .mockReturnValueOnce(selectThrowing(new Error('session lookup failed')));
      const warnSpy = vi.spyOn(logger, 'warn');
      const { ctx } = makeCtx(basePayload('WARN-TAG'));

      const response = await handleStartTransaction(ctx);

      expect(response.idTagInfo).toEqual({
        status: 'Accepted',
        expiryDate: future.toISOString(),
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ idTag: 'WARN-TAG' }),
        'Concurrent-tx lookup failed (1.6 start)',
      );
      warnSpy.mockRestore();
    });
  });
});
