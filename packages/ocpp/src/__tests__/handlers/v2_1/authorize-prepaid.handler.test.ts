// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';
import { clearPrepaidAuthorizations, prepaidCacheExpiry } from '../../../authorization/prepaid.js';

// db.select(...).from(...).where(...) is used for three different lookups in
// the handler: driver_tokens (no .limit), ocpi_external_tokens (.limit(1)) and
// charging_sessions concurrent-tx (.limit(1)). Each call to .where() pops the
// next queued result. The returned object is both awaitable and exposes
// .limit() so both call shapes resolve to the same queued value.
let whereQueue: Array<unknown[] | Error>;
const insertValuesFn = vi.fn().mockResolvedValue(undefined);
const executeFn = vi.fn();

function nextResult(): PromiseLike<unknown[]> & { limit: () => Promise<unknown[]> } {
  const queued = whereQueue.shift();
  const resolve = (): Promise<unknown[]> => {
    if (queued instanceof Error) return Promise.reject(queued);
    return Promise.resolve(queued ?? []);
  };
  return {
    then: (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected),
    limit: () => resolve(),
  };
}

const whereFn = vi.fn((): unknown => nextResult());
const fromFn = vi.fn(() => ({ where: whereFn }));
const selectFn = vi.fn(() => ({ from: fromFn }));

const isRoamingEnabledMock = vi.fn().mockResolvedValue(false);
const isSiteFreeVendEnabledByStationMock = vi.fn().mockResolvedValue(false);

vi.mock('@evtivity/database', () => ({
  db: {
    select: selectFn,
    insert: vi.fn(() => ({ values: insertValuesFn })),
    execute: executeFn,
  },
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
  ocpiExternalTokens: {
    isValid: 'is_valid',
    whitelist: 'whitelist',
    tokenData: 'token_data',
    uid: 'uid',
  },
  chargingSessions: {
    id: 'id',
    tokenId: 'token_id',
    status: 'status',
  },
  authorizeAttempts: {},
  isRoamingEnabled: isRoamingEnabledMock,
  isSiteFreeVendEnabledByStation: isSiteFreeVendEnabledByStationMock,
  getCompanyCurrency: vi.fn().mockResolvedValue('USD'),
  getCompanyTaxBasis: vi.fn().mockResolvedValue('net'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ type: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  sql: Object.assign(
    vi.fn((..._args: unknown[]) => ({ type: 'sql' })),
    { raw: vi.fn() },
  ),
}));

const logger = pino({ level: 'silent' });

function makeCtx(payload: Record<string, unknown>): {
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
      ocppProtocol: 'ocpp2.1',
      bootStatus: null,
      readyAnnounced: false,
    },
    messageId: 'msg-1',
    action: 'Authorize',
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
let authorizeHandlerModule: typeof import('../../../handlers/v2_1/authorize.handler.js');
beforeAll(async () => {
  authorizeHandlerModule = await import('../../../handlers/v2_1/authorize.handler.js');
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  clearPrepaidAuthorizations();
  whereQueue = [];
  isRoamingEnabledMock.mockResolvedValue(false);
  isSiteFreeVendEnabledByStationMock.mockResolvedValue(false);
  insertValuesFn.mockResolvedValue(undefined);
  executeFn.mockResolvedValue([]);
});

function tokenRow(prepaidBalanceCents: number | null): Record<string, unknown> {
  return {
    id: 'dtk_prepaid',
    driverId: 'drv_1',
    isActive: true,
    expiresAt: null,
    revokedAt: null,
    prepaidBalanceCents,
  };
}

function isNow(value: unknown): boolean {
  return typeof value === 'string' && Math.abs(Date.parse(value) - Date.now()) < 5_000;
}

describe('v2_1 Authorize handler - prepaid tokens (C17)', () => {
  it('accepts a prepaid token with credit and sets cacheExpiryDateTime to now (C17.FR.01)', async () => {
    whereQueue = [[tokenRow(5000)], []];
    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx({ idToken: { idToken: 'PREPAID-1', type: 'ISO14443' } });

    const response = await handleAuthorize(ctx);
    const info = response['idTokenInfo'] as Record<string, unknown>;

    expect(info['status']).toBe('Accepted');
    expect(info['groupIdToken']).toEqual({ idToken: 'PREPAID-1', type: 'ISO14443' });
    expect(isNow(info['cacheExpiryDateTime'])).toBe(true);
    // The TransactionEventResponse repeats the same value.
    expect(prepaidCacheExpiry('CS-001', 'PREPAID-1')).toBe(info['cacheExpiryDateTime']);
  });

  it('answers NoCredit with cacheExpiryDateTime now when the balance is zero (C17.FR.02)', async () => {
    whereQueue = [[tokenRow(0)], []];
    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx({ idToken: { idToken: 'PREPAID-0', type: 'ISO14443' } });

    const response = await handleAuthorize(ctx);
    const info = response['idTokenInfo'] as Record<string, unknown>;

    expect(info['status']).toBe('NoCredit');
    expect(info['groupIdToken']).toBeUndefined();
    expect(isNow(info['cacheExpiryDateTime'])).toBe(true);
    expect(response['tariff']).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(insertValuesFn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'no_credit', reason: 'no_credit' }),
    );
  });

  it('answers NoCredit for a negative balance', async () => {
    whereQueue = [[tokenRow(-250)], []];
    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx({ idToken: { idToken: 'PREPAID-NEG', type: 'ISO14443' } });

    const response = await handleAuthorize(ctx);

    expect((response['idTokenInfo'] as Record<string, unknown>)['status']).toBe('NoCredit');
  });

  it('keeps ConcurrentTx for a prepaid token with a running transaction', async () => {
    whereQueue = [[tokenRow(5000)], [{ id: 'ses_running' }]];
    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx({ idToken: { idToken: 'PREPAID-1', type: 'ISO14443' } });

    const response = await handleAuthorize(ctx);

    expect(response['idTokenInfo']).toEqual({ status: 'ConcurrentTx' });
  });

  it('omits cacheExpiryDateTime for a postpaid token without expiry', async () => {
    whereQueue = [[tokenRow(null)], []];
    const { handleAuthorize } = authorizeHandlerModule;
    const { ctx } = makeCtx({ idToken: { idToken: 'POSTPAID', type: 'ISO14443' } });

    const response = await handleAuthorize(ctx);
    const info = response['idTokenInfo'] as Record<string, unknown>;

    expect(info['status']).toBe('Accepted');
    expect(info['cacheExpiryDateTime']).toBeUndefined();
  });
});
