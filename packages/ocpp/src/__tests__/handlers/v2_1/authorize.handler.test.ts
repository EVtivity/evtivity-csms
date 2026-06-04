// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { HandlerContext } from '../../../server/middleware/pipeline.js';

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
    },
    messageId: 'msg-1',
    action: 'Authorize',
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
  whereQueue = [];
  isRoamingEnabledMock.mockResolvedValue(false);
  isSiteFreeVendEnabledByStationMock.mockResolvedValue(false);
  insertValuesFn.mockResolvedValue(undefined);
  executeFn.mockResolvedValue([]);
});

describe('v2_1 Authorize handler', () => {
  it('publishes ocpp.Authorize domain event with normalized payload', async () => {
    whereQueue = [[]];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx, publishMock } = makeCtx({
      idToken: { idToken: 'unknown-rfid', type: 'ISO14443' },
    });
    await handleAuthorize(ctx);

    expect(publishMock).toHaveBeenCalledWith({
      eventType: 'ocpp.Authorize',
      aggregateType: 'Driver',
      aggregateId: 'unknown-rfid',
      payload: { idToken: 'unknown-rfid', tokenType: 'ISO14443', stationId: 'CS-001' },
    });
  });

  it('accepts NoAuthorization token without DB lookup', async () => {
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'no-auth', type: 'NoAuthorization' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
    expect(selectFn).not.toHaveBeenCalled();
  });

  it('accepts MasterPass token without DB lookup and returns groupIdToken', async () => {
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'master', type: 'MasterPass' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'master', type: 'MasterPass' } },
    });
    expect(selectFn).not.toHaveBeenCalled();
  });

  it('accepts eMAID token without lookup and sets certificateStatus when certificate present', async () => {
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'emaid-1', type: 'eMAID' },
      certificate: 'cert-pem',
    });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'emaid-1', type: 'eMAID' } },
      certificateStatus: 'Accepted',
    });
  });

  it('sets certificateStatus for eMAID when iso15118CertificateHashData present', async () => {
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'emaid-2', type: 'eMAID' },
      iso15118CertificateHashData: [{ hashAlgorithm: 'SHA256' }],
    });
    const response = await handleAuthorize(ctx);

    expect(response).toMatchObject({ certificateStatus: 'Accepted' });
  });

  it('omits certificateStatus for eMAID when no certificate or hash data', async () => {
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'emaid-3', type: 'eMAID' } });
    const response = await handleAuthorize(ctx);

    expect(response).not.toHaveProperty('certificateStatus');
  });

  it('accepts Central token not found in DB and returns groupIdToken', async () => {
    whereQueue = [[]];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'central-token', type: 'Central' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: {
        status: 'Accepted',
        groupIdToken: { idToken: 'central-token', type: 'Central' },
      },
    });
  });

  it('returns Invalid for ISO14443 token not found in DB (roaming disabled)', async () => {
    whereQueue = [[]];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'unknown-rfid', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Invalid' } });
    expect(isRoamingEnabledMock).toHaveBeenCalled();
  });

  it('accepts active token found in DB and includes cacheExpiryDateTime when expiry set', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    // [0]=driverTokens lookup (active), [1]=concurrent-tx (none)
    whereQueue = [
      [{ id: 'dtk_1', driverId: 'drv_1', isActive: true, expiresAt, revokedAt: null }],
      [],
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'active-rfid', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: {
        status: 'Accepted',
        groupIdToken: { idToken: 'active-rfid', type: 'ISO14443' },
        cacheExpiryDateTime: expiresAt.toISOString(),
      },
    });
  });

  it('accepts active token with no expiry (omits cacheExpiryDateTime)', async () => {
    whereQueue = [
      [{ id: 'dtk_2', driverId: 'drv_2', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'active-no-exp', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: {
        status: 'Accepted',
        groupIdToken: { idToken: 'active-no-exp', type: 'ISO14443' },
      },
    });
  });

  it('blocks inactive token found in DB', async () => {
    whereQueue = [
      [{ id: 'dtk_3', driverId: 'drv_3', isActive: false, expiresAt: null, revokedAt: null }],
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'blocked-rfid', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Blocked' } });
  });

  it('blocks a revoked token even when active', async () => {
    whereQueue = [
      [
        {
          id: 'dtk_4',
          driverId: 'drv_4',
          isActive: true,
          expiresAt: null,
          revokedAt: new Date(),
        },
      ],
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'revoked-rfid', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Blocked' } });
  });

  it('returns Expired for a token past its expiry', async () => {
    whereQueue = [
      [
        {
          id: 'dtk_5',
          driverId: 'drv_5',
          isActive: true,
          expiresAt: new Date(Date.now() - 1000),
          revokedAt: null,
        },
      ],
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'expired-rfid', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Expired' } });
  });

  it('returns ConcurrentTx when matched token already has an active session', async () => {
    whereQueue = [
      [{ id: 'dtk_6', driverId: 'drv_6', isActive: true, expiresAt: null, revokedAt: null }],
      [{ id: 'ses_active' }],
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'busy-rfid', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'ConcurrentTx' } });
  });

  it('still accepts when concurrent-tx lookup throws', async () => {
    whereQueue = [
      [{ id: 'dtk_7', driverId: 'drv_7', isActive: true, expiresAt: null, revokedAt: null }],
      new Error('session query failed'),
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'rfid-7', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toMatchObject({ idTokenInfo: { status: 'Accepted' } });
  });

  it('falls open to Accepted when the driver_tokens lookup throws', async () => {
    whereQueue = [new Error('db down')];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'rfid-err', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
  });

  it('attaches a tariff when one resolves for an accepted driver token', async () => {
    whereQueue = [
      [{ id: 'dtk_8', driverId: 'drv_8', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    executeFn.mockResolvedValue([
      {
        id: 'trf_1',
        currency: 'USD',
        price_per_kwh: '0.25',
        price_per_minute: '0.15',
        price_per_session: '2.00',
        idle_fee_price_per_minute: '0.05',
        tax_rate: '0.08',
        pricing_group_id: 'pgr_1',
      },
    ]);
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'tariff-rfid', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response['tariff']).toEqual({
      tariffId: 'trf_1',
      currency: 'USD',
      energy: { prices: [{ priceKwh: 0.25 }], taxRates: [{ type: 'VAT', tax: 0.08 }] },
      chargingTime: { prices: [{ priceMinute: 0.15 }], taxRates: [{ type: 'VAT', tax: 0.08 }] },
      idleTime: { prices: [{ priceMinute: 0.05 }], taxRates: [{ type: 'VAT', tax: 0.08 }] },
      fixedFee: { prices: [{ priceFixed: 2 }], taxRates: [{ type: 'VAT', tax: 0.08 }] },
    });
  });

  it('omits tariff when resolution returns no rows', async () => {
    whereQueue = [
      [{ id: 'dtk_9', driverId: 'drv_9', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    executeFn.mockResolvedValue([]);
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'no-tariff', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).not.toHaveProperty('tariff');
  });

  it('omits tariff (no crash) when resolution throws', async () => {
    whereQueue = [
      [{ id: 'dtk_10', driverId: 'drv_10', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    executeFn.mockRejectedValue(new Error('tariff query failed'));
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'tariff-err', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response).toMatchObject({ idTokenInfo: { status: 'Accepted' } });
    expect(response).not.toHaveProperty('tariff');
  });

  describe('free vend', () => {
    it('accepts any token when the site is free-vend, with a matched driver token', async () => {
      isSiteFreeVendEnabledByStationMock.mockResolvedValue(true);
      whereQueue = [[{ id: 'dtk_fv', driverId: 'drv_fv' }]];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'fv-rfid', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
      // free-vend short-circuit returns before any tariff resolution
      expect(executeFn).not.toHaveBeenCalled();
    });

    it('accepts free-vend even when the matched-token lookup throws', async () => {
      isSiteFreeVendEnabledByStationMock.mockResolvedValue(true);
      whereQueue = [new Error('lookup failed')];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'fv-err', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
    });
  });

  describe('OCPI external token fallback', () => {
    it('accepts a valid external token (roaming enabled, ALWAYS whitelist)', async () => {
      isRoamingEnabledMock.mockResolvedValue(true);
      whereQueue = [
        [], // driver_tokens miss
        [{ isValid: true, whitelist: 'ALWAYS', tokenData: {} }], // ocpi lookup
      ];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'ocpi-ok', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
    });

    it('blocks an external token with whitelist NEVER', async () => {
      isRoamingEnabledMock.mockResolvedValue(true);
      whereQueue = [[], [{ isValid: true, whitelist: 'NEVER', tokenData: {} }]];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'ocpi-never', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Blocked' } });
    });

    it('blocks an external token that is not valid', async () => {
      isRoamingEnabledMock.mockResolvedValue(true);
      whereQueue = [[], [{ isValid: false, whitelist: 'ALWAYS', tokenData: {} }]];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'ocpi-invalid', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Blocked' } });
    });

    it('expires an external token whose valid_thru is in the past', async () => {
      isRoamingEnabledMock.mockResolvedValue(true);
      whereQueue = [
        [],
        [
          {
            isValid: true,
            whitelist: 'ALWAYS',
            tokenData: { valid_thru: new Date(Date.now() - 1000).toISOString() },
          },
        ],
      ];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'ocpi-expired', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Expired' } });
    });

    it('returns Invalid when roaming enabled but no external token row exists', async () => {
      isRoamingEnabledMock.mockResolvedValue(true);
      whereQueue = [[], []];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'ocpi-miss', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Invalid' } });
    });

    it('returns Invalid when the OCPI lookup throws (tables may not exist)', async () => {
      isRoamingEnabledMock.mockResolvedValue(true);
      whereQueue = [[], new Error('relation does not exist')];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'ocpi-throw', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Invalid' } });
    });
  });
});
