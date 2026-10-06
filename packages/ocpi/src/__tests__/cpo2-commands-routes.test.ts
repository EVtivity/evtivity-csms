// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { StationLevelState } from '@evtivity/database';
import type { OcpiPartnerInfo } from '../middleware/ocpi-auth.js';

// Each awaited query chain resolves to the next queued result.
let dbResults: unknown[][] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return chain;
}

const { mockFindEvseByUid, mockDispatch, mockRegister, mockVisible } = vi.hoisted(() => ({
  mockFindEvseByUid: vi.fn(),
  mockDispatch: vi.fn(),
  mockRegister: vi.fn(),
  mockVisible: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeChain()) },
}));

let partner: OcpiPartnerInfo | undefined;
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: async (request: { ocpiPartner?: OcpiPartnerInfo }) => {
    if (partner != null) request.ocpiPartner = partner;
  },
}));
vi.mock('../lib/location-visibility.js', () => ({ isLocationVisibleToPartner: mockVisible }));
vi.mock('../lib/evse-lookup.js', () => ({ findEvseByUid: mockFindEvseByUid }));
vi.mock('../services/command-callback.service.js', () => ({
  getCommandCallbackService: () => ({
    generateCommandId: () => 'cmd-1',
    registerCommand: mockRegister,
    dispatchOcppCommand: mockDispatch,
  }),
}));

const { cpoCommandRoutes } = await import('../routes/cpo/commands.js');

const PARTNER: OcpiPartnerInfo = {
  partnerId: 'opr_000000000001',
  partnerName: 'Partner One',
  countryCode: 'NL',
  partyId: 'EMS',
  allowPrivateNetwork: false,
  tokenId: 1,
};

const AVAILABLE: StationLevelState = {
  disabledReason: null,
  firmwareState: null,
  reportedStatus: null,
};
const SITE_ID = 'sit_000000000001';
const EVSE = {
  evseDbId: 'evs_aaaaaaaaaaaa',
  evseNumber: 2,
  stationDbId: 'sta_000000000002',
  stationOcppId: 'CS-0002',
  siteId: SITE_ID,
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  stationState: AVAILABLE,
  stationRemoved: false,
};
const STATION_ROW = {
  stationDbId: 'sta_000000000003',
  stationId: 'CS-0003',
  ...AVAILABLE,
};
const VALID_TOKEN = [{ isValid: true }];
const PUBLISHED = [{ siteId: SITE_ID }];
const NO_MAINTENANCE: unknown[] = [];
const RESPONSE_URL = 'https://partner.example.com/commands/1';

function without(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  cpoCommandRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  dbResults = [];
  partner = { ...PARTNER };
  mockFindEvseByUid.mockReset();
  mockDispatch.mockReset().mockResolvedValue(undefined);
  mockRegister.mockReset();
  mockVisible.mockReset().mockResolvedValue(true);
});

function post(command: string, payload: unknown, version = '2.2.1') {
  return app.inject({
    method: 'POST',
    url: `/ocpi/${version}/cpo/commands/${command}`,
    payload: payload as Record<string, unknown>,
  });
}

function result(res: { json: () => unknown }): string | undefined {
  return (res.json() as { data: { result?: string } | null }).data?.result;
}

const START = {
  response_url: RESPONSE_URL,
  token: { uid: 'TOKEN-1' },
  location_id: SITE_ID,
};

describe('authentication on every command', () => {
  for (const command of [
    'START_SESSION',
    'STOP_SESSION',
    'RESERVE_NOW',
    'CANCEL_RESERVATION',
    'UNLOCK_CONNECTOR',
  ]) {
    it(`${command} answers 401 without a registered partner`, async () => {
      partner = { ...PARTNER, partnerId: null };
      const res = await post(command, {});
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ status_code: 2000, status_message: 'Not authenticated' });
    });
  }
});

describe('START_SESSION', () => {
  it('rejects a body without a token object with 400 and 2001', async () => {
    const res = await post('START_SESSION', { ...START, token: 'TOKEN-1' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      status_code: 2001,
      status_message: 'Invalid StartSession command',
    });
  });

  it('rejects a body without a location_id', async () => {
    const res = await post('START_SESSION', { response_url: RESPONSE_URL, token: { uid: 'X' } });
    expect(res.statusCode).toBe(400);
  });

  it('answers REJECTED for an unknown token', async () => {
    dbResults = [[]];
    const res = await post('START_SESSION', START);
    expect(res.json()).toMatchObject({
      status_code: 1000,
      data: { result: 'REJECTED', timeout: 30 },
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('answers REJECTED for a blocked token', async () => {
    dbResults = [[{ isValid: false }]];
    expect(result(await post('START_SESSION', START))).toBe('REJECTED');
  });

  it('answers REJECTED for an unpublished location', async () => {
    dbResults = [VALID_TOKEN, []];
    expect(result(await post('START_SESSION', START))).toBe('REJECTED');
    expect(mockVisible).not.toHaveBeenCalled();
  });

  it('answers REJECTED for a location not visible to the partner', async () => {
    mockVisible.mockResolvedValue(false);
    dbResults = [VALID_TOKEN, PUBLISHED];
    expect(result(await post('START_SESSION', START))).toBe('REJECTED');
    expect(mockVisible).toHaveBeenCalledWith(PARTNER.partnerId, SITE_ID);
  });

  it('answers REJECTED when a site-wide maintenance window covers every station', async () => {
    dbResults = [VALID_TOKEN, PUBLISHED, [{ affectedStationIds: null }], [STATION_ROW]];
    expect(result(await post('START_SESSION', START))).toBe('REJECTED');
  });

  it('answers REJECTED for a maintenance window with an empty station list', async () => {
    dbResults = [VALID_TOKEN, PUBLISHED, [{ affectedStationIds: [] }], [STATION_ROW]];
    expect(result(await post('START_SESSION', START))).toBe('REJECTED');
  });

  it('adds the connector id when the EVSE has that connector', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, [{ connectorId: 1 }]];
    const res = await post('START_SESSION', {
      ...START,
      evse_uid: EVSE.evseDbId,
      connector_id: '1',
    });
    expect(result(res)).toBe('ACCEPTED');
    expect(mockRegister).toHaveBeenCalledWith(
      'cmd-1',
      RESPONSE_URL,
      PARTNER.partnerId,
      'START_SESSION',
    );
    const [, stationId, action, payload] = mockDispatch.mock.calls[0] as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(stationId).toBe('CS-0002');
    expect(action).toBe('RequestStartTransaction');
    expect(payload).toMatchObject({ idTag: 'TOKEN-1', evseId: 2, connectorId: 1 });
    expect(typeof payload['remoteStartId']).toBe('number');
  });

  it('omits the connector id when the EVSE has no such connector', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, []];
    await post('START_SESSION', { ...START, evse_uid: EVSE.evseDbId, connector_id: '9' });
    const payload = mockDispatch.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('connectorId');
    expect(payload['evseId']).toBe(2);
  });

  it('omits the connector id for a non-numeric connector without a lookup', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, [{ connectorId: 1 }]];
    await post('START_SESSION', { ...START, evse_uid: EVSE.evseDbId, connector_id: 'abc' });
    const payload = mockDispatch.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('connectorId');
    expect(dbResults).toHaveLength(1);
  });

  it('ignores the connector id when no EVSE uid was given', async () => {
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, [STATION_ROW]];
    await post('START_SESSION', { ...START, connector_id: '1' });
    const [, stationId, , payload] = mockDispatch.mock.calls[0] as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(stationId).toBe('CS-0003');
    expect(payload).not.toHaveProperty('evseId');
    expect(payload).not.toHaveProperty('connectorId');
  });

  it('accepts a private https response_url for a partner with the private-network flag', async () => {
    partner = { ...PARTNER, allowPrivateNetwork: true };
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, [STATION_ROW]];
    const res = await post('START_SESSION', { ...START, response_url: 'http://10.0.0.5/cb' });
    expect(result(res)).toBe('ACCEPTED');
  });

  it('refuses a non-http response_url even with the private-network flag', async () => {
    partner = { ...PARTNER, allowPrivateNetwork: true };
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, [STATION_ROW]];
    const res = await post('START_SESSION', { ...START, response_url: 'ftp://10.0.0.5/cb' });
    expect(res.json()).toMatchObject({
      status_code: 2001,
      status_message: 'response_url is not allowed',
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('refuses an unparsable response_url with the private-network flag', async () => {
    partner = { ...PARTNER, allowPrivateNetwork: true };
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, [STATION_ROW]];
    const res = await post('START_SESSION', { ...START, response_url: 'not a url' });
    expect(res.json()).toMatchObject({ status_code: 2001 });
  });
});

describe('STOP_SESSION', () => {
  const STOP = { response_url: RESPONSE_URL, session_id: 'OCPI-SES-1' };

  it('rejects a body without a session_id with 400', async () => {
    const res = await post('STOP_SESSION', { response_url: RESPONSE_URL });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status_message: 'Invalid StopSession command' });
  });

  it('answers UNKNOWN_SESSION for a session the partner does not have', async () => {
    dbResults = [[]];
    expect(result(await post('STOP_SESSION', STOP))).toBe('UNKNOWN_SESSION');
  });

  it('answers REJECTED for a received session without a charging session', async () => {
    dbResults = [[{ chargingSessionId: null }]];
    expect(result(await post('STOP_SESSION', STOP))).toBe('REJECTED');
  });

  it('answers REJECTED when the charging session is gone', async () => {
    dbResults = [[{ chargingSessionId: 'ses_1' }], []];
    expect(result(await post('STOP_SESSION', STOP))).toBe('REJECTED');
  });

  it('refuses a private response_url', async () => {
    dbResults = [[{ chargingSessionId: 'ses_1' }], [{ stationId: 'CS-1', transactionId: 'TX-1' }]];
    const res = await post('STOP_SESSION', { ...STOP, response_url: 'http://127.0.0.1/cb' });
    expect(res.json()).toMatchObject({ status_code: 2001 });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('dispatches RequestStopTransaction with the transaction id', async () => {
    dbResults = [[{ chargingSessionId: 'ses_1' }], [{ stationId: 'CS-1', transactionId: 'TX-1' }]];
    const res = await post('STOP_SESSION', STOP, '2.3.0');
    expect(res.json()).toMatchObject({
      status_code: 1000,
      data: { result: 'ACCEPTED', timeout: 30 },
    });
    expect(mockRegister).toHaveBeenCalledWith(
      'cmd-1',
      RESPONSE_URL,
      PARTNER.partnerId,
      'STOP_SESSION',
    );
    expect(mockDispatch).toHaveBeenCalledWith('cmd-1', 'CS-1', 'RequestStopTransaction', {
      transactionId: 'TX-1',
    });
  });
});

describe('RESERVE_NOW', () => {
  const RESERVE = {
    response_url: RESPONSE_URL,
    token: { uid: 'TOKEN-1' },
    expiry_date: '2026-10-02T12:00:00Z',
    reservation_id: 'abc',
    location_id: SITE_ID,
  };

  it('rejects a body without an expiry_date with 400', async () => {
    const missing = without(RESERVE, 'expiry_date');
    const res = await post('RESERVE_NOW', missing);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status_message: 'Invalid ReserveNow command' });
  });

  it('answers REJECTED for a blocked token', async () => {
    dbResults = [[{ isValid: false }]];
    expect(result(await post('RESERVE_NOW', RESERVE))).toBe('REJECTED');
  });

  it('answers REJECTED for an unknown location', async () => {
    dbResults = [VALID_TOKEN, []];
    expect(result(await post('RESERVE_NOW', RESERVE))).toBe('REJECTED');
  });

  it('answers REJECTED for an EVSE uid at another site', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, siteId: 'sit_other' });
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE];
    expect(result(await post('RESERVE_NOW', { ...RESERVE, evse_uid: EVSE.evseDbId }))).toBe(
      'REJECTED',
    );
  });

  it('falls back to reservation id 1 for a non-numeric id and omits the EVSE without a uid', async () => {
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, [STATION_ROW]];
    expect(result(await post('RESERVE_NOW', RESERVE))).toBe('ACCEPTED');
    expect(mockDispatch).toHaveBeenCalledWith('cmd-1', 'CS-0003', 'ReserveNow', {
      id: 1,
      expiryDateTime: RESERVE.expiry_date,
      idToken: { idToken: 'TOKEN-1', type: 'ISO14443' },
    });
  });

  it('refuses a private response_url', async () => {
    dbResults = [VALID_TOKEN, PUBLISHED, NO_MAINTENANCE, [STATION_ROW]];
    const res = await post('RESERVE_NOW', { ...RESERVE, response_url: 'http://192.168.1.1/cb' });
    expect(res.json()).toMatchObject({ status_code: 2001 });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('CANCEL_RESERVATION', () => {
  it('rejects a body without a reservation_id with 400', async () => {
    const res = await post('CANCEL_RESERVATION', { response_url: RESPONSE_URL });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status_message: 'Invalid CancelReservation command' });
  });

  it('always answers REJECTED and dispatches nothing', async () => {
    const res = await post('CANCEL_RESERVATION', {
      response_url: RESPONSE_URL,
      reservation_id: '7',
    });
    expect(res.json()).toMatchObject({
      status_code: 1000,
      data: { result: 'REJECTED', timeout: 30 },
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('UNLOCK_CONNECTOR', () => {
  const UNLOCK = {
    response_url: RESPONSE_URL,
    location_id: SITE_ID,
    evse_uid: EVSE.evseDbId,
    connector_id: '1',
  };

  it('rejects a body without a connector_id with 400', async () => {
    const missing = without(UNLOCK, 'connector_id');
    const res = await post('UNLOCK_CONNECTOR', missing);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status_message: 'Invalid UnlockConnector command' });
  });

  it('answers REJECTED for an unknown location', async () => {
    dbResults = [[]];
    expect(result(await post('UNLOCK_CONNECTOR', UNLOCK))).toBe('REJECTED');
    expect(mockFindEvseByUid).not.toHaveBeenCalled();
  });

  it('answers REJECTED for an unknown EVSE uid', async () => {
    mockFindEvseByUid.mockResolvedValue(null);
    dbResults = [PUBLISHED];
    expect(result(await post('UNLOCK_CONNECTOR', UNLOCK))).toBe('REJECTED');
  });

  it('answers REJECTED for a non-numeric connector id', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [PUBLISHED];
    expect(result(await post('UNLOCK_CONNECTOR', { ...UNLOCK, connector_id: 'x' }))).toBe(
      'REJECTED',
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('refuses a private response_url', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [PUBLISHED];
    const res = await post('UNLOCK_CONNECTOR', { ...UNLOCK, response_url: 'http://10.1.1.1/cb' });
    expect(res.json()).toMatchObject({ status_code: 2001 });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
