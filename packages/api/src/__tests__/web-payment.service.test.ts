// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptString, totpV1 } from '@evtivity/lib';

const { KEY } = vi.hoisted(() => ({ KEY: 'test-settings-encryption-key-32ch' }));

vi.mock('../lib/config.js', () => ({
  config: { SETTINGS_ENCRYPTION_KEY: KEY, PORTAL_URL: 'https://portal.example.com/' },
}));

// Every awaited query chain resolves to the next queued result.
let dbResults: unknown[][] = [];
let dbCallIndex = 0;
const insertValues = vi.fn();
const onConflict = vi.fn();
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'returning']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['values'] = vi.fn((v: unknown) => {
    insertValues(v);
    return chain;
  });
  chain['onConflictDoUpdate'] = vi.fn((v: unknown) => {
    onConflict(v);
    return chain;
  });
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

const writeAudit = vi.fn();
vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  chargingStations: {},
  evses: {},
  stationAuditLog: {},
  stationWebPaymentConfigs: {},
  writeAudit: (...args: unknown[]) => {
    writeAudit(...args);
    return Promise.resolve();
  },
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn() }));

const sendOcppCommandAndWait = vi.fn();
vi.mock('@evtivity/services/ocpp-command', () => ({
  sendOcppCommandAndWait: (...args: unknown[]) => sendOcppCommandAndWait(...args),
}));

import {
  enableWebPayments,
  disableWebPayments,
  validateQrCodeUrl,
  qrUrlTemplate,
} from '../services/web-payment.service.js';

const ctx = {
  actor: {
    actor: 'operator' as const,
    actorUserId: 'usr_1',
    actorDriverId: null,
    actorApiKeyId: null,
    actorLabel: null,
  },
  log: { warn: vi.fn() },
};
const STATION = { id: 'sta_1', stationId: 'CS-1', ocppProtocol: 'ocpp2.1', isOnline: true };

function accepted(names: string[]) {
  return {
    commandId: 'c',
    response: {
      setVariableResult: names.map((name) => ({
        attributeStatus: 'Accepted',
        component: { name: 'WebPaymentsCtrlr' },
        variable: { name },
      })),
    },
  };
}

const ALL_VARIABLES = [
  'URLTemplate',
  'TOTPVersion',
  'ValidityTime',
  'Length',
  'SharedSecret',
  'Enabled',
];

beforeEach(() => {
  vi.clearAllMocks();
  dbResults = [];
  dbCallIndex = 0;
});

describe('enableWebPayments', () => {
  it('sets WebPaymentsCtrlr on the station and stores the encrypted secret once accepted', async () => {
    sendOcppCommandAndWait.mockResolvedValue(accepted(ALL_VARIABLES));
    dbResults = [
      [STATION], // loadStation
      [], // upsert
      [STATION], // getWebPaymentConfig: loadStation
      [
        {
          validitySeconds: 30,
          totpLength: 8,
          totpVersion: 'v1',
          urlTemplate: qrUrlTemplate(),
        },
      ],
    ];

    const view = await enableWebPayments('sta_1', { validitySeconds: 30, totpLength: 8 }, ctx);

    expect(view).toEqual({
      enabled: true,
      validitySeconds: 30,
      totpLength: 8,
      totpVersion: 'v1',
      urlTemplate: 'https://portal.example.com/qr/{chargingstationid}/{evse}/{totp}/{version}',
    });
    const payload = sendOcppCommandAndWait.mock.calls[0]?.[2] as {
      setVariableData: { variable: { name: string }; attributeValue: string }[];
    };
    const values = Object.fromEntries(
      payload.setVariableData.map((d) => [d.variable.name, d.attributeValue]),
    );
    expect(values).toMatchObject({
      URLTemplate: 'https://portal.example.com/qr/{chargingstationid}/{evse}/{totp}/{version}',
      TOTPVersion: 'v1',
      ValidityTime: '30',
      Length: '8',
      Enabled: 'true',
    });
    expect(values['SharedSecret']?.length).toBeGreaterThanOrEqual(8);
    const stored = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(stored['sharedSecretEnc']).not.toBe(values['SharedSecret']);
    expect(stored).toMatchObject({ stationId: 'sta_1', validitySeconds: 30, totpLength: 8 });
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it('stores nothing when the station refuses a variable', async () => {
    const response = accepted(ALL_VARIABLES);
    (response.response.setVariableResult[4] as { attributeStatus: string }).attributeStatus =
      'Rejected';
    sendOcppCommandAndWait.mockResolvedValue(response);
    dbResults = [[STATION]];

    await expect(
      enableWebPayments('sta_1', { validitySeconds: 30, totpLength: 8 }, ctx),
    ).rejects.toMatchObject({ code: 'STATION_SECURITY_CHANGE_REJECTED', statusCode: 502 });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('fails with OCPP_COMMAND_FAILED when the station does not answer', async () => {
    sendOcppCommandAndWait.mockResolvedValue({ commandId: 'c', error: 'No response within 35s' });
    dbResults = [[STATION]];

    await expect(
      enableWebPayments('sta_1', { validitySeconds: 30, totpLength: 8 }, ctx),
    ).rejects.toMatchObject({ code: 'OCPP_COMMAND_FAILED' });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('refuses an offline station and an OCPP 1.6 station', async () => {
    dbResults = [[{ ...STATION, isOnline: false }]];
    await expect(
      enableWebPayments('sta_1', { validitySeconds: 30, totpLength: 8 }, ctx),
    ).rejects.toMatchObject({ code: 'STATION_OFFLINE' });

    dbResults = [[{ ...STATION, ocppProtocol: 'ocpp1.6' }]];
    dbCallIndex = 0;
    await expect(
      enableWebPayments('sta_1', { validitySeconds: 30, totpLength: 8 }, ctx),
    ).rejects.toMatchObject({ code: 'OCPP_VERSION_MISMATCH' });
    expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
  });
});

describe('disableWebPayments', () => {
  it('sets Enabled false on an online station and removes the secret', async () => {
    sendOcppCommandAndWait.mockResolvedValue(accepted(['Enabled']));
    dbResults = [[STATION], [{ stationId: 'sta_1' }], [STATION], []];

    const view = await disableWebPayments('sta_1', ctx);

    expect(view.enabled).toBe(false);
    expect(sendOcppCommandAndWait.mock.calls[0]?.[2]).toEqual({
      setVariableData: [
        {
          component: { name: 'WebPaymentsCtrlr' },
          variable: { name: 'Enabled' },
          attributeValue: 'false',
        },
      ],
    });
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it('removes the secret of an offline station without a command', async () => {
    dbResults = [[{ ...STATION, isOnline: false }], [{ stationId: 'sta_1' }], [STATION], []];
    await disableWebPayments('sta_1', ctx);
    expect(sendOcppCommandAndWait).not.toHaveBeenCalled();
  });
});

describe('validateQrCodeUrl', () => {
  const NOW = 1_790_000_000_000;
  const params = { sharedSecret: 'qr-shared-secret-1', validitySeconds: 30, length: 8 };
  const config = {
    stationDbId: 'sta_1',
    sharedSecretEnc: encryptString(params.sharedSecret, KEY),
    validitySeconds: 30,
    totpLength: 8,
    totpVersion: 'v1',
  };
  const url = (path: string) => `https://portal.example.com${path}?maxenergy=20000`;

  it('accepts the current one-time password', async () => {
    dbResults = [[config], [{ id: 'evs_1' }]];
    const totp = totpV1(params, NOW);
    expect(await validateQrCodeUrl(url(`/qr/CS-1/1/${totp}/v1`), NOW)).toEqual({
      valid: true,
      stationId: 'CS-1',
      evseId: 1,
    });
  });

  it('accepts the previous interval and refuses an older one', async () => {
    dbResults = [[config], [{ id: 'evs_1' }]];
    expect(
      (await validateQrCodeUrl(url(`/qr/CS-1/1/${totpV1(params, NOW - 30_000)}/v1`), NOW)).valid,
    ).toBe(true);

    dbResults = [[config]];
    dbCallIndex = 0;
    expect(
      await validateQrCodeUrl(url(`/qr/CS-1/1/${totpV1(params, NOW - 90_000)}/v1`), NOW),
    ).toEqual({ valid: false, reason: 'invalid_totp' });
  });

  it('refuses a URL without the charging station identity (TC_C_132)', async () => {
    const totp = totpV1(params, NOW);
    expect(await validateQrCodeUrl(url(`/qr/1/${totp}/v1`), NOW)).toEqual({
      valid: false,
      reason: 'missing_parameter',
    });
    expect(await validateQrCodeUrl(url(`/qr//1/${totp}/v1`), NOW)).toEqual({
      valid: false,
      reason: 'missing_parameter',
    });
  });

  it('refuses an invalid one-time password (TC_C_133)', async () => {
    dbResults = [[config]];
    expect(await validateQrCodeUrl(url('/qr/CS-1/1/AAAAAAAA/v1'), NOW)).toEqual({
      valid: false,
      reason: 'invalid_totp',
    });
  });

  it('refuses an unknown station, another version, an unknown EVSE, and a malformed URL', async () => {
    const totp = totpV1(params, NOW);
    dbResults = [[]];
    expect(await validateQrCodeUrl(url(`/qr/CS-9/1/${totp}/v1`), NOW)).toEqual({
      valid: false,
      reason: 'unknown_station',
    });
    dbResults = [[config]];
    dbCallIndex = 0;
    expect(await validateQrCodeUrl(url(`/qr/CS-1/1/${totp}/v2`), NOW)).toEqual({
      valid: false,
      reason: 'unsupported_version',
    });
    dbResults = [[config], []];
    dbCallIndex = 0;
    expect(await validateQrCodeUrl(url(`/qr/CS-1/7/${totp}/v1`), NOW)).toEqual({
      valid: false,
      reason: 'unknown_evse',
    });
    expect(await validateQrCodeUrl('not a url', NOW)).toEqual({
      valid: false,
      reason: 'malformed_url',
    });
    expect(await validateQrCodeUrl(url(`/qr/CS-1/abc/${totp}/v1`), NOW)).toEqual({
      valid: false,
      reason: 'missing_parameter',
    });
  });
});
