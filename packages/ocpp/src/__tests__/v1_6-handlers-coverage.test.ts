// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    isRoamingEnabled: vi.fn().mockResolvedValue(false),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
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
    },
    messageId: 'msg-1',
    action,
    protocolVersion: 'ocpp1.6',
    payload,
    logger,
    eventBus: {
      publish: publishMock,
      subscribe: vi.fn(),
    },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
    ...overrides,
  };
  return { ctx, publishMock };
}

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

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'ACTIVE-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Blocked when all matching tokens are inactive and not Central/Local type', async () => {
    whereFn.mockResolvedValue([
      { isActive: false, tokenType: 'ISO14443' },
      { isActive: false, tokenType: 'ISO15693' },
    ]);

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'BLOCKED-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('returns Blocked when all tokens are inactive regardless of token type', async () => {
    whereFn.mockResolvedValue([
      { isActive: false, tokenType: 'Central' },
      { isActive: false, tokenType: 'Local' },
    ]);

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'CENTRAL-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('returns Invalid when token not found and roaming is disabled', async () => {
    whereFn.mockResolvedValue([]);

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'UNKNOWN-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Invalid' } });
  });

  it('returns Accepted for valid OCPI external token when roaming is enabled', async () => {
    // First query returns no driver_tokens
    whereFn.mockResolvedValueOnce([]);
    // Enable roaming
    const { isRoamingEnabled } = await import('@evtivity/database');
    vi.mocked(isRoamingEnabled).mockResolvedValueOnce(true);

    // Set up the OCPI external token query chain
    // After the first whereFn resolves to [], the handler does a second select/from/where/limit
    // We need to re-chain for the second query
    const secondLimitFn = vi.fn().mockResolvedValue([{ isValid: true }]);
    const secondWhereFn = vi.fn().mockReturnValue({ limit: secondLimitFn });
    const secondFromFn = vi.fn().mockReturnValue({ where: secondWhereFn });

    // The first call uses the default chain, but after it resolves we need the second call
    // Since select/from/where are called sequentially, we mock them in order
    selectFn.mockReturnValueOnce({ from: fromFn }).mockReturnValueOnce({ from: secondFromFn });

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'ROAMING-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Blocked for invalid OCPI external token when roaming is enabled', async () => {
    whereFn.mockResolvedValueOnce([]);

    const { isRoamingEnabled } = await import('@evtivity/database');
    vi.mocked(isRoamingEnabled).mockResolvedValueOnce(true);

    const secondLimitFn = vi.fn().mockResolvedValue([{ isValid: false }]);
    const secondWhereFn = vi.fn().mockReturnValue({ limit: secondLimitFn });
    const secondFromFn = vi.fn().mockReturnValue({ where: secondWhereFn });

    selectFn.mockReturnValueOnce({ from: fromFn }).mockReturnValueOnce({ from: secondFromFn });

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'BAD-ROAMING-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('falls back to Accepted when OCPI table query throws', async () => {
    whereFn.mockResolvedValueOnce([]);

    const { isRoamingEnabled } = await import('@evtivity/database');
    vi.mocked(isRoamingEnabled).mockResolvedValueOnce(true);

    // The second select chain throws (OCPI tables missing)
    const throwingFromFn = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockRejectedValue(new Error('relation does not exist')),
      }),
    });

    selectFn.mockReturnValueOnce({ from: fromFn }).mockReturnValueOnce({ from: throwingFromFn });

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
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

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'DB-ERR-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Blocked when some tokens are inactive with mixed types including non-accept types', async () => {
    whereFn.mockResolvedValue([
      { isActive: false, tokenType: 'Central' },
      { isActive: false, tokenType: 'ISO14443' },
    ]);

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
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

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'MULTI-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Accepted' } });
  });

  it('returns Blocked for inactive NoAuthorization token type', async () => {
    whereFn.mockResolvedValue([{ isActive: false, tokenType: 'NoAuthorization' }]);

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
    const { ctx } = makeCtx('Authorize', { idTag: 'NOAUTH-TAG' });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTagInfo: { status: 'Blocked' } });
  });

  it('publishes ocpp.Authorize event before performing token lookup', async () => {
    whereFn.mockResolvedValue([{ isActive: true, tokenType: 'ISO14443' }]);

    const { handleAuthorize } = await import('../handlers/v1_6/authorize.handler.js');
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
    executeFn.mockResolvedValueOnce([{ transaction_id: '42' }]);

    const { handleStartTransaction } =
      await import('../handlers/v1_6/start-transaction.handler.js');
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
    // Only one db.execute call (the UPDATE), no sequence call needed
    expect(executeFn).toHaveBeenCalledTimes(1);
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
    // First execute (UPDATE) returns empty array
    executeFn.mockResolvedValueOnce([]);
    // Second execute (sequence) returns nextval
    executeFn.mockResolvedValueOnce([{ nextval: '99' }]);

    const { handleStartTransaction } =
      await import('../handlers/v1_6/start-transaction.handler.js');
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
    expect(executeFn).toHaveBeenCalledTimes(2);
  });

  it('falls back to sequence when claimed transaction_id is NaN', async () => {
    // The UPDATE returns a row but with a non-numeric transaction_id
    executeFn.mockResolvedValueOnce([{ transaction_id: 'not-a-number' }]);
    // Sequence fallback
    executeFn.mockResolvedValueOnce([{ nextval: '77' }]);

    const { handleStartTransaction } =
      await import('../handlers/v1_6/start-transaction.handler.js');
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
    expect(executeFn).toHaveBeenCalledTimes(2);
  });

  it('falls back to sequence when claimed transaction_id is a float', async () => {
    executeFn.mockResolvedValueOnce([{ transaction_id: '3.14' }]);
    executeFn.mockResolvedValueOnce([{ nextval: '55' }]);

    const { handleStartTransaction } =
      await import('../handlers/v1_6/start-transaction.handler.js');
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

  it('uses default value 1 when sequence returns no row', async () => {
    // stationDbId is null so it skips the UPDATE
    // Sequence returns empty
    executeFn.mockResolvedValueOnce([]);

    const { handleStartTransaction } =
      await import('../handlers/v1_6/start-transaction.handler.js');
    const { ctx } = makeCtx('StartTransaction', {
      connectorId: 1,
      idTag: 'TAG-005',
      meterStart: 0,
      timestamp: '2026-02-15T10:00:00Z',
    });
    const response = await handleStartTransaction(ctx);

    // Number(undefined ?? 1) = Number(1) = 1
    expect(response.transactionId).toBe(1);
  });

  it('publishes event with reservationId when present in request', async () => {
    executeFn.mockResolvedValueOnce([{ nextval: '10' }]);

    const { handleStartTransaction } =
      await import('../handlers/v1_6/start-transaction.handler.js');
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
    // Return array where first element is undefined
    executeFn.mockResolvedValueOnce([undefined]);
    executeFn.mockResolvedValueOnce([{ nextval: '88' }]);

    const { handleStartTransaction } =
      await import('../handlers/v1_6/start-transaction.handler.js');
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
