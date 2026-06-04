// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

const selectFn = vi.fn();
const insertFn = vi.fn();
const valuesFn = vi.fn();

vi.mock('@evtivity/database', () => {
  insertFn.mockReturnValue({ values: valuesFn });
  valuesFn.mockResolvedValue(undefined);
  return {
    db: { select: selectFn, insert: insertFn },
    driverTokens: { id: 'id', driverId: 'driver_id', idToken: 'id_token', isActive: 'is_active' },
    drivers: { id: 'id', isActive: 'is_active' },
    ocpiExternalTokens: {
      isValid: 'is_valid',
      whitelist: 'whitelist',
      uid: 'uid',
      tokenData: 'token_data',
    },
    chargingSessions: { id: 'id', tokenId: 'token_id', status: 'status' },
    guestSessions: {
      sessionToken: 'session_token',
      status: 'status',
      stationOcppId: 'station_ocpp_id',
    },
    authorizeAttempts: { __table: 'authorize_attempts' },
    isRoamingEnabled: vi.fn().mockResolvedValue(false),
    isSiteFreeVendEnabledByStation: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
}));

import { handleAuthorize } from '../../../handlers/v1_6/authorize.handler.js';
import { isRoamingEnabled, isSiteFreeVendEnabledByStation } from '@evtivity/database';

const logger = pino({ level: 'silent' });

// Build a `db.select()` chain whose terminal `.where()` (token lookup) or
// `.where().limit()` (driver/guest/ocpi/session lookups) resolves to `rows`.
function selectResolving(rows: unknown[]): { from: ReturnType<typeof vi.fn> } {
  const limit = vi.fn().mockResolvedValue(rows);
  // `.where()` must be both awaitable (token lookup uses `await ...where(...)`)
  // and chainable to `.limit()` (the fallbacks use `.where(...).limit(1)`).
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

function makeCtx(idTag: string): {
  ctx: HandlerContext;
  publishMock: ReturnType<typeof vi.fn>;
} {
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
    action: 'Authorize',
    protocolVersion: 'ocpp1.6',
    payload: { idTag },
    logger,
    eventBus: { publish: publishMock, subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
  return { ctx, publishMock };
}

// Returns the most recent authorize_attempts row written via db.insert().values().
function lastAttemptRow(): Record<string, unknown> {
  const call = valuesFn.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  insertFn.mockReturnValue({ values: valuesFn });
  valuesFn.mockResolvedValue(undefined);
  vi.mocked(isRoamingEnabled).mockResolvedValue(false);
  vi.mocked(isSiteFreeVendEnabledByStation).mockResolvedValue(false);
});

describe('OCPP 1.6 Authorize handler', () => {
  it('publishes ocpp.Authorize before the token lookup', async () => {
    selectFn.mockReturnValue(selectResolving([]));
    const { ctx, publishMock } = makeCtx('EVT-TAG');

    await handleAuthorize(ctx);

    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.Authorize',
      aggregateType: 'Driver',
      aggregateId: 'EVT-TAG',
      payload: { stationId: 'CS-001', idToken: 'EVT-TAG', tokenType: 'ISO14443' },
    });
  });

  describe('free-vend short-circuit', () => {
    it('accepts any token and logs free_vend with a matched driver when card is known', async () => {
      vi.mocked(isSiteFreeVendEnabledByStation).mockResolvedValue(true);
      selectFn.mockReturnValue(selectResolving([{ id: 'dtk_fv', driverId: 'drv_fv' }]));
      const { ctx } = makeCtx('FREE-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'accepted',
        reason: 'free_vend',
        tokenType: null,
        matchedTokenId: 'dtk_fv',
        matchedDriverId: 'drv_fv',
      });
    });

    it('accepts with null matched ids when the best-effort lookup returns nothing', async () => {
      vi.mocked(isSiteFreeVendEnabledByStation).mockResolvedValue(true);
      selectFn.mockReturnValue(selectResolving([]));
      const { ctx } = makeCtx('FREE-UNKNOWN');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'accepted',
        reason: 'free_vend',
        matchedTokenId: null,
        matchedDriverId: null,
      });
    });

    it('treats a null driverId from the lookup row as null matchedDriverId', async () => {
      vi.mocked(isSiteFreeVendEnabledByStation).mockResolvedValue(true);
      selectFn.mockReturnValue(selectResolving([{ id: 'dtk_fv2', driverId: null }]));
      const { ctx } = makeCtx('FREE-NODRV');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({
        matchedTokenId: 'dtk_fv2',
        matchedDriverId: null,
      });
    });

    it('still accepts when the best-effort lookup throws', async () => {
      vi.mocked(isSiteFreeVendEnabledByStation).mockResolvedValue(true);
      selectFn.mockReturnValue(selectThrowing(new Error('lookup failed')));
      const { ctx } = makeCtx('FREE-ERR');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'accepted',
        reason: 'free_vend',
        matchedTokenId: null,
        matchedDriverId: null,
      });
    });
  });

  describe('driver_tokens match matrix', () => {
    it('Accepted with expiryDate when an active, non-revoked, future-expiry token matches', async () => {
      const future = new Date(Date.now() + 86_400_000);
      selectFn.mockReturnValue(
        selectResolving([
          { id: 'dtk_ok', driverId: 'drv_ok', isActive: true, expiresAt: future, revokedAt: null },
        ]),
      );
      const { ctx } = makeCtx('GOOD-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({
        idTagInfo: { status: 'Accepted', expiryDate: future.toISOString() },
      });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'accepted',
        matchedTokenId: 'dtk_ok',
        matchedDriverId: 'drv_ok',
        tokenType: 'ISO14443',
        reason: null,
      });
    });

    it('Accepted without expiryDate when the matched token has no expiry', async () => {
      selectFn.mockReturnValue(
        selectResolving([
          {
            id: 'dtk_noexp',
            driverId: 'drv_noexp',
            isActive: true,
            expiresAt: null,
            revokedAt: null,
          },
        ]),
      );
      const { ctx } = makeCtx('NOEXP-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
    });

    it('Expired when the only matching token has a past expiry', async () => {
      const past = new Date(Date.now() - 60_000);
      selectFn.mockReturnValue(
        selectResolving([
          { id: 'dtk_exp', driverId: 'drv_exp', isActive: true, expiresAt: past, revokedAt: null },
        ]),
      );
      const { ctx } = makeCtx('EXP-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Expired' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'expired',
        reason: 'expired_at',
        matchedTokenId: 'dtk_exp',
        matchedDriverId: 'drv_exp',
      });
    });

    it('Blocked when the token is inactive (no expiry to surface)', async () => {
      selectFn.mockReturnValue(
        selectResolving([
          {
            id: 'dtk_inact',
            driverId: 'drv_inact',
            isActive: false,
            expiresAt: null,
            revokedAt: null,
          },
        ]),
      );
      const { ctx } = makeCtx('INACT-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'blocked',
        reason: 'inactive_or_revoked',
        matchedTokenId: 'dtk_inact',
      });
    });

    it('Blocked when the token is revoked', async () => {
      selectFn.mockReturnValue(
        selectResolving([
          {
            id: 'dtk_rev',
            driverId: 'drv_rev',
            isActive: true,
            expiresAt: null,
            revokedAt: new Date(),
          },
        ]),
      );
      const { ctx } = makeCtx('REV-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'blocked', reason: 'inactive_or_revoked' });
    });

    it('prefers the usable token when both usable and unusable rows match', async () => {
      const future = new Date(Date.now() + 86_400_000);
      selectFn.mockReturnValue(
        selectResolving([
          { id: 'dtk_bad', driverId: 'drv_bad', isActive: false, expiresAt: null, revokedAt: null },
          {
            id: 'dtk_good',
            driverId: 'drv_good',
            isActive: true,
            expiresAt: future,
            revokedAt: null,
          },
        ]),
      );
      const { ctx } = makeCtx('MULTI-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({
        idTagInfo: { status: 'Accepted', expiryDate: future.toISOString() },
      });
      expect(lastAttemptRow()).toMatchObject({ matchedTokenId: 'dtk_good' });
    });
  });

  describe('driver-id fallback (drv_ prefix)', () => {
    it('Accepted for an active driver, returns early and logs driver_id', async () => {
      // First select (driver_tokens) empty, second select (drivers) returns active driver.
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([{ id: 'drv_123', isActive: true }]));
      const { ctx } = makeCtx('drv_123');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'accepted',
        reason: 'driver_id',
        matchedDriverId: 'drv_123',
        tokenType: null,
      });
    });

    it('Blocked for an inactive driver, returns early and logs driver_inactive', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([{ id: 'drv_off', isActive: false }]));
      const { ctx } = makeCtx('drv_off');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'blocked',
        reason: 'driver_inactive',
        matchedDriverId: 'drv_off',
      });
    });

    it('falls through to guest lookup when the drv_ id does not resolve to a driver', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([])) // driver_tokens
        .mockReturnValueOnce(selectResolving([])) // drivers (not found)
        .mockReturnValueOnce(selectResolving([])); // guest_sessions (not found)
      const { ctx } = makeCtx('drv_missing');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Invalid' } });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'unknown', reason: 'token_not_found' });
    });
  });

  describe('guest_sessions fallback', () => {
    it('Accepted when guest session is payment_authorized', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([])) // driver_tokens
        .mockReturnValueOnce(selectResolving([{ status: 'payment_authorized' }])); // guest_sessions
      const { ctx } = makeCtx('GUEST-OK');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'accepted', reason: 'guest_session' });
    });

    it('Blocked when guest session is in a non-authorized state', async () => {
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([{ status: 'pending' }]));
      const { ctx } = makeCtx('GUEST-PENDING');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'blocked', reason: 'guest_pending' });
    });
  });

  describe('OCPI external token fallback', () => {
    it('does not query OCPI when roaming is disabled, returns Invalid', async () => {
      vi.mocked(isRoamingEnabled).mockResolvedValue(false);
      selectFn
        .mockReturnValueOnce(selectResolving([])) // driver_tokens
        .mockReturnValueOnce(selectResolving([])); // guest_sessions
      const { ctx } = makeCtx('NO-ROAM');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Invalid' } });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'unknown', reason: 'token_not_found' });
    });

    it('Accepted for a valid OCPI token with permissive whitelist and no valid_thru', async () => {
      vi.mocked(isRoamingEnabled).mockResolvedValue(true);
      selectFn
        .mockReturnValueOnce(selectResolving([])) // driver_tokens
        .mockReturnValueOnce(selectResolving([])) // guest_sessions
        .mockReturnValueOnce(
          selectResolving([{ isValid: true, whitelist: 'ALWAYS', tokenData: null }]),
        );
      const { ctx } = makeCtx('OCPI-OK');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'accepted', reason: 'ocpi_external' });
    });

    it('Blocked for an OCPI token with whitelist NEVER', async () => {
      vi.mocked(isRoamingEnabled).mockResolvedValue(true);
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(
          selectResolving([{ isValid: true, whitelist: 'NEVER', tokenData: null }]),
        );
      const { ctx } = makeCtx('OCPI-NEVER');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'blocked', reason: 'ocpi_external_never' });
    });

    it('Blocked for an OCPI token that is not valid', async () => {
      vi.mocked(isRoamingEnabled).mockResolvedValue(true);
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(
          selectResolving([{ isValid: false, whitelist: 'ALWAYS', tokenData: null }]),
        );
      const { ctx } = makeCtx('OCPI-INVALID');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'blocked',
        reason: 'ocpi_external_always',
      });
    });

    it('Expired for an OCPI token whose valid_thru is in the past', async () => {
      vi.mocked(isRoamingEnabled).mockResolvedValue(true);
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(
          selectResolving([
            {
              isValid: true,
              whitelist: 'ALWAYS',
              tokenData: { valid_thru: '2000-01-01T00:00:00Z' },
            },
          ]),
        );
      const { ctx } = makeCtx('OCPI-EXP');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Expired' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'expired',
        reason: 'ocpi_external_valid_thru_expired',
      });
    });

    it('Invalid when the OCPI table query throws (tables missing in env)', async () => {
      vi.mocked(isRoamingEnabled).mockResolvedValue(true);
      selectFn
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectResolving([]))
        .mockReturnValueOnce(selectThrowing(new Error('relation does not exist')));
      const { ctx } = makeCtx('OCPI-ERR');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Invalid' } });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'unknown', reason: 'token_not_found' });
    });
  });

  describe('fail-open on DB error', () => {
    it('Accepted with outcome db_error when the outer token query throws', async () => {
      selectFn.mockImplementationOnce(() => {
        throw new Error('connection refused');
      });
      const { ctx } = makeCtx('DB-ERR');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'db_error',
        reason: 'db_unreachable',
        matchedTokenId: null,
        matchedDriverId: null,
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
        .mockReturnValueOnce(selectResolving([{ id: 'ses_active' }])); // active-session lookup
      const { ctx } = makeCtx('BUSY-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTagInfo: { status: 'ConcurrentTx' } });
      expect(lastAttemptRow()).toMatchObject({
        outcome: 'concurrent_tx',
        reason: 'concurrent_session ses_active',
        matchedTokenId: 'dtk_busy',
      });
    });

    it('stays Accepted when no active session exists for the matched token', async () => {
      const future = new Date(Date.now() + 86_400_000);
      selectFn
        .mockReturnValueOnce(
          selectResolving([
            {
              id: 'dtk_free',
              driverId: 'drv_free',
              isActive: true,
              expiresAt: future,
              revokedAt: null,
            },
          ]),
        )
        .mockReturnValueOnce(selectResolving([])); // no active session
      const { ctx } = makeCtx('FREE-TOKEN');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({
        idTagInfo: { status: 'Accepted', expiryDate: future.toISOString() },
      });
      expect(lastAttemptRow()).toMatchObject({ outcome: 'accepted' });
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
      const { ctx } = makeCtx('WARN-TAG');

      const response = await handleAuthorize(ctx);

      expect(response).toEqual({
        idTagInfo: { status: 'Accepted', expiryDate: future.toISOString() },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ idTag: 'WARN-TAG' }),
        'Concurrent-tx lookup failed (1.6)',
      );
      expect(lastAttemptRow()).toMatchObject({ outcome: 'accepted' });
      warnSpy.mockRestore();
    });
  });
});
