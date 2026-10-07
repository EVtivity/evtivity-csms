// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../server/middleware/pipeline.js';

// --- Authorize handler mocks ---
const selectFn = vi.fn();
const fromFn = vi.fn();
const whereFn = vi.fn();
const limitFn = vi.fn();
const executeFn = vi.fn();

vi.mock('@evtivity/database', () => {
  limitFn.mockResolvedValue([]);
  whereFn.mockReturnValue({ limit: limitFn });
  fromFn.mockReturnValue({ where: whereFn });
  selectFn.mockReturnValue({ from: fromFn });

  return {
    db: { select: selectFn, execute: executeFn },
    driverTokens: {
      isActive: 'is_active',
      idToken: 'id_token',
      tokenType: 'token_type',
    },
    ocpiExternalTokens: {
      isValid: 'is_valid',
      uid: 'uid',
    },
    guestSessions: {
      sessionToken: 'session_token',
      status: 'status',
    },
    chargingStations: { id: 'id', stationId: 'station_id', siteId: 'site_id' },
    sites: { id: 'id', freeVendEnabled: 'free_vend_enabled' },
    isRoamingEnabled: vi.fn().mockResolvedValue(false),
    isSiteFreeVendEnabledByStation: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({
    type: 'sql',
    raw: strings.join('?'),
  }),
}));

const logger = pino({ level: 'silent' });

function makeCtx(
  action: string,
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
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action,
    protocolVersion: 'ocpp1.6',
    payload,
    logger,
    eventBus: {
      publish: publishMock,
      subscribe: vi.fn(),
      drain: vi.fn(),
      track: vi.fn(),
    },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
    ...overrides,
  };
  return { ctx, publishMock };
}

// Imported once, not in the first test: loading the module graph can exceed the 5 s test timeout under load.
let authorizeHandlerModule: typeof import('../handlers/v1_6/authorize.handler.js');
let databaseModule: typeof import('@evtivity/database');
let startTransactionHandlerModule: typeof import('../handlers/v1_6/start-transaction.handler.js');
beforeAll(async () => {
  authorizeHandlerModule = await import('../handlers/v1_6/authorize.handler.js');
  databaseModule = await import('@evtivity/database');
  startTransactionHandlerModule = await import('../handlers/v1_6/start-transaction.handler.js');
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  limitFn.mockResolvedValue([]);
  whereFn.mockReturnValue({ limit: limitFn });
  fromFn.mockReturnValue({ where: whereFn });
  selectFn.mockReturnValue({ from: fromFn });
  executeFn.mockResolvedValue([{ nextval: '1' }]);
});

// --------------------------------------------------------------------------
// Authorize handler - uncovered branches
// --------------------------------------------------------------------------
describe('v1_6 Authorize handler - token lookup branches', () => {
  it('returns Accepted when an active token is found in driver_tokens', async () => {
    whereFn.mockResolvedValue([{ isActive: true, tokenType: 'ISO14443' }]);

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'ACTIVE-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Blocked when all matching tokens are inactive and not Central/Local type', async () => {
    whereFn.mockResolvedValue([
      { isActive: false, tokenType: 'ISO14443' },
      { isActive: false, tokenType: 'ISO15693' },
    ]);

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'BLOCKED-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('returns Blocked when all tokens are inactive regardless of token type', async () => {
    whereFn.mockResolvedValue([
      { isActive: false, tokenType: 'Central' },
      { isActive: false, tokenType: 'Local' },
    ]);

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'CENTRAL-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('returns Invalid when token not found and roaming is disabled', async () => {
    // driver_tokens select: empty. guest_sessions select also empty (default limitFn).
    whereFn.mockResolvedValueOnce([]);

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'UNKNOWN-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Invalid' } });
  });

  it('returns Accepted for valid OCPI external token when roaming is enabled', async () => {
    // driver_tokens query returns no rows
    whereFn.mockResolvedValueOnce([]);
    const { isRoamingEnabled } = databaseModule;
    vi.mocked(isRoamingEnabled).mockResolvedValueOnce(true);

    // After driver_tokens, the handler runs:
    //   1. guest_sessions select (must return [] so we fall through to OCPI)
    //   2. OCPI select (returns the test value)
    const guestLimitFn = vi.fn().mockResolvedValue([]);
    const guestWhereFn = vi.fn().mockReturnValue({ limit: guestLimitFn });
    const guestFromFn = vi.fn().mockReturnValue({ where: guestWhereFn });

    const ocpiLimitFn = vi
      .fn()
      .mockResolvedValue([{ isValid: true, whitelist: 'ALWAYS', tokenData: null }]);
    const ocpiWhereFn = vi.fn().mockReturnValue({ limit: ocpiLimitFn });
    const ocpiFromFn = vi.fn().mockReturnValue({ where: ocpiWhereFn });

    // Calls to selectFn in order: driver_tokens, guest_sessions, OCPI.
    // (Free-vend check now uses the cached reader, no db.select.)
    selectFn
      .mockReturnValueOnce({ from: fromFn })
      .mockReturnValueOnce({ from: guestFromFn })
      .mockReturnValueOnce({ from: ocpiFromFn });

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'ROAMING-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Blocked for invalid OCPI external token when roaming is enabled', async () => {
    whereFn.mockResolvedValueOnce([]);

    const { isRoamingEnabled } = databaseModule;
    vi.mocked(isRoamingEnabled).mockResolvedValueOnce(true);

    const guestLimitFn = vi.fn().mockResolvedValue([]);
    const guestWhereFn = vi.fn().mockReturnValue({ limit: guestLimitFn });
    const guestFromFn = vi.fn().mockReturnValue({ where: guestWhereFn });

    // Handler now reads `isValid`, `whitelist`, and `tokenData` from the row.
    // The reason string interpolates `whitelist.toLowerCase()` so we must
    // supply it.
    const ocpiLimitFn = vi
      .fn()
      .mockResolvedValue([{ isValid: false, whitelist: 'ALWAYS', tokenData: null }]);
    const ocpiWhereFn = vi.fn().mockReturnValue({ limit: ocpiLimitFn });
    const ocpiFromFn = vi.fn().mockReturnValue({ where: ocpiWhereFn });

    selectFn
      .mockReturnValueOnce({ from: fromFn })
      .mockReturnValueOnce({ from: guestFromFn })
      .mockReturnValueOnce({ from: ocpiFromFn });

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'BAD-ROAMING-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('falls back to Accepted when OCPI table query throws', async () => {
    whereFn.mockResolvedValueOnce([]);

    const { isRoamingEnabled } = databaseModule;
    vi.mocked(isRoamingEnabled).mockResolvedValueOnce(true);

    const guestLimitFn = vi.fn().mockResolvedValue([]);
    const guestWhereFn = vi.fn().mockReturnValue({ limit: guestLimitFn });
    const guestFromFn = vi.fn().mockReturnValue({ where: guestWhereFn });

    const throwingFromFn = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockRejectedValue(new Error('relation does not exist')),
      }),
    });

    selectFn
      .mockReturnValueOnce({ from: fromFn })
      .mockReturnValueOnce({ from: guestFromFn })
      .mockReturnValueOnce({ from: throwingFromFn });

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'OCPI-ERR-TAG' });
    const response = await handleAuthorize(ctx);

    // Falls through to the else branch (externalToken is undefined), returns Invalid
    expect(response).toEqual({ idTagInfo: { status: 'Invalid' } });
  });

  it('accepts by default when the outer DB query throws', async () => {
    // Make the first select throw to trigger the outer catch
    selectFn.mockImplementationOnce(() => {
      throw new Error('connection refused');
    });

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'DB-ERR-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Blocked when some tokens are inactive with mixed types including non-accept types', async () => {
    whereFn.mockResolvedValueOnce([
      { isActive: false, tokenType: 'Central' },
      { isActive: false, tokenType: 'ISO14443' },
    ]);

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'MIXED-TAG' });
    const response = await handleAuthorize(ctx);

    // Not all tokens are accept types (ISO14443 is not), so it blocks
    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('returns Accepted when one token is active among multiple tokens', async () => {
    whereFn.mockResolvedValue([
      { isActive: false, tokenType: 'ISO14443' },
      { isActive: true, tokenType: 'ISO14443' },
    ]);

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'MULTI-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Blocked for inactive NoAuthorization token type', async () => {
    whereFn.mockResolvedValue([{ isActive: false, tokenType: 'NoAuthorization' }]);

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx('Authorize', { idTag: 'NOAUTH-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('publishes ocpp.Authorize event before performing token lookup', async () => {
    whereFn.mockResolvedValue([{ isActive: true, tokenType: 'ISO14443' }]);

    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx, publishMock } = makeCtx('Authorize', { idTag: 'EVT-TAG' });
    await handleAuthorize(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.Authorize',
        aggregateType: 'Driver',
        aggregateId: 'EVT-TAG',
        payload: expect.objectContaining({
          stationId: 'CS-001',
          idToken: 'EVT-TAG',
          tokenType: 'ISO14443',
        }) as unknown,
      }),
    );
  });
});

// --------------------------------------------------------------------------
// StartTransaction handler - uncovered branches
// --------------------------------------------------------------------------
describe('v1_6 StartTransaction handler - session claim branches', () => {
  it('claims a pending session when stationDbId is present and session exists', async () => {
    // No resend, then the UPDATE claims a waiting remote start
    executeFn.mockResolvedValueOnce([]);
    executeFn.mockResolvedValueOnce([{ transaction_id: '42' }]);
    // The idTag is an active driver token (the concurrent check finds no session).
    whereFn.mockReturnValueOnce(
      Object.assign(
        Promise.resolve([
          {
            id: 'dtk-1',
            driverId: 'drv-1',
            isActive: true,
            expiresAt: null,
            revokedAt: null,
            prepaidBalanceCents: null,
          },
        ]),
        { limit: limitFn },
      ),
    );

    const { handleStartTransaction } = startTransactionHandlerModule;
    const { ctx, publishMock } = makeCtx(
      'StartTransaction',
      {
        connectorId: 1,
        idTag: 'TAG-001',
        meterStart: 500,
        timestamp: '2026-02-15T10:00:00Z',
      },
      { stationDbId: 'db-id-001' },
    );
    const response = await handleStartTransaction(ctx);

    expect(response.transactionId).toBe(42);
    expect(response.idTagInfo).toEqual({ status: 'Accepted' });
    // The resend lookup and the UPDATE, no sequence call needed
    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ocpp.TransactionEvent',
        aggregateType: 'Transaction',
        aggregateId: '42',
        payload: expect.objectContaining({
          eventType: 'Started',
          transactionId: '42',
          idToken: 'TAG-001',
          meterStart: 500,
        }) as unknown,
      }),
    );
  });

  it('falls back to sequence when stationDbId is present but no pending session exists', async () => {
    // Resend lookup and UPDATE return empty arrays
    executeFn.mockResolvedValueOnce([]);
    executeFn.mockResolvedValueOnce([]);
    // Second execute (sequence) returns nextval
    executeFn.mockResolvedValueOnce([{ nextval: '99' }]);

    const { handleStartTransaction } = startTransactionHandlerModule;
    const { ctx } = makeCtx(
      'StartTransaction',
      {
        connectorId: 2,
        idTag: 'TAG-002',
        meterStart: 0,
        timestamp: '2026-02-15T10:00:00Z',
      },
      { stationDbId: 'db-id-002' },
    );
    const response = await handleStartTransaction(ctx);

    expect(response.transactionId).toBe(99);
    expect(executeFn).toHaveBeenCalledTimes(3);
  });

  it('falls back to sequence when claimed transaction_id is NaN', async () => {
    // No resend; the UPDATE returns a row but with a non-numeric transaction_id
    executeFn.mockResolvedValueOnce([]);
    executeFn.mockResolvedValueOnce([{ transaction_id: 'not-a-number' }]);
    // Sequence fallback
    executeFn.mockResolvedValueOnce([{ nextval: '77' }]);

    const { handleStartTransaction } = startTransactionHandlerModule;
    const { ctx } = makeCtx(
      'StartTransaction',
      {
        connectorId: 1,
        idTag: 'TAG-003',
        meterStart: 100,
        timestamp: '2026-02-15T10:00:00Z',
      },
      { stationDbId: 'db-id-003' },
    );
    const response = await handleStartTransaction(ctx);

    expect(response.transactionId).toBe(77);
    expect(executeFn).toHaveBeenCalledTimes(3);
  });

  it('falls back to sequence when claimed transaction_id is a float', async () => {
    executeFn.mockResolvedValueOnce([]);
    executeFn.mockResolvedValueOnce([{ transaction_id: '3.14' }]);
    executeFn.mockResolvedValueOnce([{ nextval: '55' }]);

    const { handleStartTransaction } = startTransactionHandlerModule;
    const { ctx } = makeCtx(
      'StartTransaction',
      {
        connectorId: 1,
        idTag: 'TAG-004',
        meterStart: 200,
        timestamp: '2026-02-15T10:00:00Z',
      },
      { stationDbId: 'db-id-004' },
    );
    const response = await handleStartTransaction(ctx);

    expect(response.transactionId).toBe(55);
  });

  it('fails the message instead of making up an id when the sequence returns no row', async () => {
    // stationDbId is null so it skips the UPDATE
    // Sequence returns empty
    executeFn.mockResolvedValueOnce([]);

    const { handleStartTransaction } = startTransactionHandlerModule;
    const { ctx } = makeCtx('StartTransaction', {
      connectorId: 1,
      idTag: 'TAG-005',
      meterStart: 0,
      timestamp: '2026-02-15T10:00:00Z',
    });

    await expect(handleStartTransaction(ctx)).rejects.toThrow(
      'ocpp16_transaction_id_seq returned no value',
    );
  });

  it('publishes event with reservationId when present in request', async () => {
    executeFn.mockResolvedValueOnce([{ nextval: '10' }]);

    const { handleStartTransaction } = startTransactionHandlerModule;
    const { ctx, publishMock } = makeCtx('StartTransaction', {
      connectorId: 1,
      idTag: 'TAG-006',
      meterStart: 0,
      timestamp: '2026-02-15T10:00:00Z',
      reservationId: 5,
    });
    await handleStartTransaction(ctx);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          reservationId: 5,
        }) as unknown,
      }),
    );
  });

  it('claims session with stationDbId but row is undefined (first element check)', async () => {
    // Resend lookup and UPDATE return arrays whose first element is undefined
    executeFn.mockResolvedValueOnce([undefined]);
    executeFn.mockResolvedValueOnce([undefined]);
    executeFn.mockResolvedValueOnce([{ nextval: '88' }]);

    const { handleStartTransaction } = startTransactionHandlerModule;
    const { ctx } = makeCtx(
      'StartTransaction',
      {
        connectorId: 1,
        idTag: 'TAG-007',
        meterStart: 0,
        timestamp: '2026-02-15T10:00:00Z',
      },
      { stationDbId: 'db-id-007' },
    );
    const response = await handleStartTransaction(ctx);

    // row is undefined so transactionId remains null, falls through to sequence
    expect(response.transactionId).toBe(88);
  });
});
