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
// Tariff rows the shared resolver (@evtivity/database tariff-resolution) returns, first row wins.
const executeFn = vi.fn();
const resolveStationTariffMock = vi.fn(
  async (_q: { stationUuid: string; driverUuid: string | null }, _sql: unknown) => {
    const rows = (await executeFn()) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (row == null) return null;
    return {
      id: row['id'],
      pricePerKwh: row['price_per_kwh'],
      pricePerMinute: row['price_per_minute'],
      pricePerSession: row['price_per_session'],
      idleFeePricePerMinute: row['idle_fee_price_per_minute'],
      reservationFeePerMinute: null,
      taxRate: row['tax_rate'],
    };
  },
);
const clientMock = vi.fn(() => Promise.resolve([{ id: 'sta_cs001' }]));

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
const getCompanyTaxBasisMock = vi.fn().mockResolvedValue('net');
const isSiteFreeVendEnabledByStationMock = vi.fn().mockResolvedValue(false);

vi.mock('@evtivity/database', () => ({
  db: {
    select: selectFn,
    insert: vi.fn(() => ({ values: insertValuesFn })),
  },
  client: clientMock,
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
  getCompanyCurrency: vi.fn().mockResolvedValue('USD'),
  getCompanyTaxBasis: (...args: unknown[]) => getCompanyTaxBasisMock(...args) as unknown,
  resolveStationTariff: (...args: [{ stationUuid: string; driverUuid: string | null }, unknown]) =>
    resolveStationTariffMock(...args),
}));

const validateContractCertificateMock = vi.fn();

vi.mock('../../../services/pki/contract-certificate-validation.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../services/pki/contract-certificate-validation.js')
    >();
  return {
    applyContractCertificateVerdict: actual.applyContractCertificateVerdict,
    validateContractCertificate: (...args: unknown[]) =>
      validateContractCertificateMock(...args) as unknown,
  };
});

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

  it('looks up an eMAID token in driver_tokens like any other token', async () => {
    whereQueue = [
      [{ id: 'tok-e', driverId: 'drv-e', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'emaid-1', type: 'eMAID' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'emaid-1', type: 'eMAID' } },
    });
    expect(selectFn).toHaveBeenCalled();
    expect(validateContractCertificateMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown eMAID as Invalid', async () => {
    whereQueue = [[]];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'emaid-unknown', type: 'eMAID' } });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({ idTokenInfo: { status: 'Invalid' } });
  });

  it('returns certificateStatus Accepted for a valid chain and an accepted eMAID (C07.FR.14)', async () => {
    whereQueue = [
      [{ id: 'tok-e', driverId: 'drv-e', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    validateContractCertificateMock.mockResolvedValueOnce('Accepted');
    const hashData = [
      {
        hashAlgorithm: 'SHA256',
        issuerNameHash: 'aa',
        issuerKeyHash: 'bb',
        serialNumber: '1',
        responderURL: 'https://ocsp.example.com',
      },
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'emaid-2', type: 'eMAID' },
      iso15118CertificateHashData: hashData,
    });
    const response = await handleAuthorize(ctx);

    expect(validateContractCertificateMock).toHaveBeenCalledWith(
      { iso15118CertificateHashData: hashData },
      expect.anything(),
    );
    expect(response).toMatchObject({
      idTokenInfo: { status: 'Accepted', groupIdToken: { idToken: 'emaid-2', type: 'eMAID' } },
      certificateStatus: 'Accepted',
    });
  });

  it('returns Invalid and CertificateRevoked for a revoked chain on any token type (C07.FR.16)', async () => {
    whereQueue = [
      [{ id: 'tok-1', driverId: 'drv-1', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    validateContractCertificateMock.mockResolvedValueOnce('CertificateRevoked');
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'rfid-1', type: 'ISO14443' },
      iso15118CertificateHashData: [
        {
          hashAlgorithm: 'SHA256',
          issuerNameHash: 'aa',
          issuerKeyHash: 'bb',
          serialNumber: '1',
          responderURL: 'https://ocsp.example.com',
        },
      ],
    });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: { status: 'Invalid' },
      certificateStatus: 'CertificateRevoked',
    });
  });

  it('returns ContractCancelled when the chain is valid but the eMAID is unknown (C07.FR.13)', async () => {
    whereQueue = [[]];
    validateContractCertificateMock.mockResolvedValueOnce('Accepted');
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'emaid-3', type: 'eMAID' },
      certificate: 'cert-pem',
    });
    const response = await handleAuthorize(ctx);

    expect(validateContractCertificateMock).toHaveBeenCalledWith(
      { certificate: 'cert-pem' },
      expect.anything(),
    );
    expect(response).toEqual({
      idTokenInfo: { status: 'Invalid' },
      certificateStatus: 'ContractCancelled',
    });
  });

  it('fails closed with CertChainError when the validation throws (C07.FR.17)', async () => {
    whereQueue = [
      [{ id: 'tok-e', driverId: 'drv-e', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    validateContractCertificateMock.mockRejectedValueOnce(new Error('db down'));
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({
      idToken: { idToken: 'emaid-4', type: 'eMAID' },
      certificate: 'cert-pem',
    });
    const response = await handleAuthorize(ctx);

    expect(response).toEqual({
      idTokenInfo: { status: 'Invalid' },
      certificateStatus: 'CertChainError',
    });
  });

  it('omits certificateStatus when no certificate or hash data is sent', async () => {
    whereQueue = [[]];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'emaid-5', type: 'eMAID' } });
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
      energy: { prices: [{ priceKwh: 0.25 }], taxRates: [{ type: 'VAT', tax: 8 }] },
      chargingTime: { prices: [{ priceMinute: 0.15 }], taxRates: [{ type: 'VAT', tax: 8 }] },
      idleTime: { prices: [{ priceMinute: 0.05 }], taxRates: [{ type: 'VAT', tax: 8 }] },
      fixedFee: { prices: [{ priceFixed: 2 }], taxRates: [{ type: 'VAT', tax: 8 }] },
    });
    // Resolved like session pricing: the station's internal id and the token's driver.
    expect(resolveStationTariffMock).toHaveBeenCalledWith(
      { stationUuid: 'sta_cs001', driverUuid: 'drv_8' },
      clientMock,
    );
  });

  it('uses the station id from the connection without looking it up', async () => {
    whereQueue = [
      [{ id: 'dtk_s', driverId: 'drv_s', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'known-station', type: 'ISO14443' } });
    ctx.stationDbId = 'sta_known';
    await handleAuthorize(ctx);

    expect(clientMock).not.toHaveBeenCalled();
    expect(resolveStationTariffMock).toHaveBeenCalledWith(
      { stationUuid: 'sta_known', driverUuid: 'drv_s' },
      clientMock,
    );
  });

  it('sends net prices for a tariff entered on the gross tax basis', async () => {
    getCompanyTaxBasisMock.mockResolvedValueOnce('gross');
    whereQueue = [
      [{ id: 'dtk_g', driverId: 'drv_g', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    executeFn.mockResolvedValue([
      {
        id: 'trf_g',
        price_per_kwh: '0.357',
        price_per_minute: null,
        price_per_session: '1.19',
        idle_fee_price_per_minute: '0.50',
        tax_rate: '0.19',
        pricing_group_id: 'pgr_1',
      },
    ]);
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'gross-rfid', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response['tariff']).toEqual({
      tariffId: 'trf_g',
      currency: 'USD',
      energy: { prices: [{ priceKwh: 0.3 }], taxRates: [{ type: 'VAT', tax: 19 }] },
      // 0.50 / 1.19 = 0.42016...
      idleTime: { prices: [{ priceMinute: 0.4202 }], taxRates: [{ type: 'VAT', tax: 19 }] },
      fixedFee: { prices: [{ priceFixed: 1 }], taxRates: [{ type: 'VAT', tax: 19 }] },
    });
  });

  it('builds a tariff with only the non-zero price components and no tax rates', async () => {
    whereQueue = [
      [{ id: 'dtk_z', driverId: 'drv_z', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    executeFn.mockResolvedValue([
      {
        id: 'trf_2',
        price_per_kwh: '0.30',
        price_per_minute: null,
        price_per_session: '0',
        idle_fee_price_per_minute: '0',
        tax_rate: '0',
        pricing_group_id: 'pgr_2',
      },
    ]);
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'tariff-min', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    // Tariffs carry no currency; the station receives the company currency.
    expect(response['tariff']).toEqual({
      tariffId: 'trf_2',
      currency: 'USD',
      energy: { prices: [{ priceKwh: 0.3 }] },
    });
  });

  it('builds all four tariff components without tax rates when tax is zero', async () => {
    whereQueue = [
      [{ id: 'dtk_nt', driverId: 'drv_nt', isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    executeFn.mockResolvedValue([
      {
        id: 'trf_nt',
        price_per_kwh: '0.25',
        price_per_minute: '0.15',
        price_per_session: '2.00',
        idle_fee_price_per_minute: '0.05',
        tax_rate: '0',
        pricing_group_id: 'pgr_nt',
      },
    ]);
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'tariff-notax', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response['tariff']).toEqual({
      tariffId: 'trf_nt',
      currency: 'USD',
      energy: { prices: [{ priceKwh: 0.25 }] },
      chargingTime: { prices: [{ priceMinute: 0.15 }] },
      idleTime: { prices: [{ priceMinute: 0.05 }] },
      fixedFee: { prices: [{ priceFixed: 2 }] },
    });
  });

  it('resolves a tariff for an accepted token whose driverId is null (station/site path)', async () => {
    whereQueue = [
      [{ id: 'dtk_nd', driverId: null, isActive: true, expiresAt: null, revokedAt: null }],
      [],
    ];
    executeFn.mockResolvedValue([
      {
        id: 'trf_3',
        price_per_kwh: '0.40',
        price_per_minute: null,
        price_per_session: null,
        idle_fee_price_per_minute: null,
        tax_rate: null,
        pricing_group_id: 'pgr_3',
      },
    ]);
    const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
    const { ctx } = makeCtx({ idToken: { idToken: 'tariff-nd', type: 'ISO14443' } });
    const response = await handleAuthorize(ctx);

    expect(response['tariff']).toEqual({
      tariffId: 'trf_3',
      currency: 'USD',
      energy: { prices: [{ priceKwh: 0.4 }] },
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

    it('accepts free-vend when the matched token row has a null driverId', async () => {
      isSiteFreeVendEnabledByStationMock.mockResolvedValue(true);
      whereQueue = [[{ id: 'dtk_fv2', driverId: null }]];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'fv-null-driver', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
    });

    it('accepts free-vend when no matched token row exists', async () => {
      isSiteFreeVendEnabledByStationMock.mockResolvedValue(true);
      whereQueue = [[]];
      const { handleAuthorize } = await import('../../../handlers/v2_1/authorize.handler.js');
      const { ctx } = makeCtx({ idToken: { idToken: 'fv-nomatch', type: 'ISO14443' } });
      const response = await handleAuthorize(ctx);

      expect(response).toEqual({ idTokenInfo: { status: 'Accepted' } });
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
