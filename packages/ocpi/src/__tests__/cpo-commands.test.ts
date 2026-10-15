// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { StationLevelState } from '@evtivity/database';

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

const { mockFindEvseByUid, mockDispatch, mockRegister, partnerFlags } = vi.hoisted(() => ({
  mockFindEvseByUid: vi.fn(),
  mockDispatch: vi.fn().mockResolvedValue(undefined),
  mockRegister: vi.fn().mockResolvedValue(undefined),
  partnerFlags: { allowPrivateNetwork: false },
}));

vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: vi.fn(() => makeChain()) },
}));
vi.mock('../middleware/ocpi-auth.js', () => ({
  ocpiAuthenticate: async (request: { ocpiPartner?: unknown }) => {
    request.ocpiPartner = {
      partnerId: 'opr_000000000001',
      countryCode: 'NL',
      partyId: 'EMS',
      allowPrivateNetwork: partnerFlags.allowPrivateNetwork,
    };
  },
}));
vi.mock('../lib/location-visibility.js', () => ({
  isLocationVisibleToPartner: vi.fn().mockResolvedValue(true),
}));
vi.mock('../lib/evse-lookup.js', () => ({ findEvseByUid: mockFindEvseByUid }));
vi.mock('../services/command-callback.service.js', () => ({
  getCommandCallbackService: () => ({
    generateCommandId: () => 'cmd-1',
    registerCommand: mockRegister,
    dispatchOcppCommand: mockDispatch,
  }),
}));

const { cpoCommandRoutes } = await import('../routes/cpo/commands.js');

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
  mockDispatch.mockClear();
  mockRegister.mockClear();
  mockFindEvseByUid.mockReset();
  partnerFlags.allowPrivateNetwork = false;
});

const AVAILABLE: StationLevelState = {
  disabledReason: null,
  firmwareState: null,
  reportedStatus: null,
};
const DISABLED: StationLevelState = { ...AVAILABLE, disabledReason: 'operator' };
const INSTALLING: StationLevelState = { ...AVAILABLE, firmwareState: 'installing' };
const FAULTED: StationLevelState = { ...AVAILABLE, reportedStatus: 'faulted' };

const EVSE = {
  evseDbId: 'evs_aaaaaaaaaaaa',
  evseNumber: 1,
  stationDbId: 'sta_000000000002',
  stationOcppId: 'CS-0002',
  siteId: 'sit_000000000001',
  updatedAt: new Date(),
  stationState: AVAILABLE,
  stationRemoved: false,
  evseRetired: false,
  stationOnline: true,
  stationAccepted: true,
};

const UNAVAILABLE_STATES: StationLevelState[] = [
  DISABLED,
  INSTALLING,
  { ...AVAILABLE, firmwareState: 'failed' },
  { ...AVAILABLE, reportedStatus: 'unavailable' },
  FAULTED,
];

function startSession(
  evseUid?: string,
  responseUrl = 'https://partner.example.com/commands/1',
  extra: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/ocpi/2.2.1/cpo/commands/START_SESSION',
    payload: {
      response_url: responseUrl,
      token: { uid: 'TOKEN-1' },
      location_id: 'sit_000000000001',
      ...(evseUid != null ? { evse_uid: evseUid } : {}),
      ...extra,
    },
  });
}

const PUSHED_RFID = [{ isValid: true, tokenType: 'RFID' }];

function reserveNow(evseUid?: string) {
  return app.inject({
    method: 'POST',
    url: '/ocpi/2.2.1/cpo/commands/RESERVE_NOW',
    payload: {
      response_url: 'https://partner.example.com/commands/2',
      token: { uid: 'TOKEN-1' },
      expiry_date: '2026-10-02T12:00:00Z',
      reservation_id: '7',
      location_id: 'sit_000000000001',
      ...(evseUid != null ? { evse_uid: evseUid } : {}),
    },
  });
}

function stationRow(n: number, state = AVAILABLE, isOnline = true) {
  return {
    stationDbId: `sta_00000000000${String(n)}`,
    stationId: `CS-000${String(n)}`,
    ...state,
    isOnline,
  };
}

describe('OCPI START_SESSION', () => {
  it('starts on the station that owns the EVSE uid, with its EVSE number', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [
      PUSHED_RFID, // token
      [{ siteId: 'sit_000000000001' }], // location publish
      [], // maintenance events
    ];

    const res = await startSession(EVSE.evseDbId);

    expect(res.json().data.result).toBe('ACCEPTED');
    expect(mockFindEvseByUid).toHaveBeenCalledWith(EVSE.evseDbId);
    expect(mockDispatch).toHaveBeenCalledWith(
      'cmd-1',
      'CS-0002',
      'RequestStartTransaction',
      expect.objectContaining({
        evseId: 1,
        idToken: { idToken: 'TOKEN-1', type: 'ISO14443' },
        remoteStartId: expect.any(Number) as number,
      }),
    );
    const payload = mockDispatch.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('idTag');
    // The command row binds the token to the station and the partner.
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'cmd-1',
        partnerId: 'opr_000000000001',
        commandType: 'START_SESSION',
        stationId: 'CS-0002',
        tokenUid: 'TOKEN-1',
        tokenType: 'RFID',
        tokenData: null,
        remoteStartId: payload['remoteStartId'],
        authorizationReference: null,
      }),
    );
  });

  it('rejects an offline station: the command is never queued', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, stationOnline: false });
    dbResults = [PUSHED_RFID, [{ siteId: 'sit_000000000001' }], []];

    const res = await startSession(EVSE.evseDbId);

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('rejects a station that is pending or removed', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, stationAccepted: false });
    dbResults = [PUSHED_RFID, [{ siteId: 'sit_000000000001' }], []];

    const res = await startSession(EVSE.evseDbId);

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects a token the partner pushed as invalid', async () => {
    dbResults = [[{ isValid: false, tokenType: 'RFID' }]];

    const res = await startSession(EVSE.evseDbId);

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('accepts the token embedded in the command when it is the partner own', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[], [{ siteId: 'sit_000000000001' }], []];
    const token = {
      uid: 'APP-77',
      type: 'APP_USER',
      country_code: 'nl',
      party_id: 'ems',
      contract_id: 'NL-EMS-77',
      valid: true,
      whitelist: 'NEVER',
    };

    const res = await startSession(EVSE.evseDbId, undefined, {
      token,
      authorization_reference: 'AUTH-1',
    });

    expect(res.json().data.result).toBe('ACCEPTED');
    expect(mockDispatch).toHaveBeenCalledWith(
      'cmd-1',
      'CS-0002',
      'RequestStartTransaction',
      expect.objectContaining({ idToken: { idToken: 'APP-77', type: 'Central' } }),
    );
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenUid: 'APP-77',
        tokenType: 'APP_USER',
        tokenData: token,
        authorizationReference: 'AUTH-1',
      }),
    );
  });

  it.each([
    ['another party', { country_code: 'NL', party_id: 'OTH' }],
    ['another country', { country_code: 'DE', party_id: 'EMS' }],
    ['no country or party', {}],
    ['an invalid token', { country_code: 'NL', party_id: 'EMS', valid: false }],
  ])('rejects an embedded token of %s', async (_name, fields) => {
    dbResults = [[]];

    const res = await startSession(EVSE.evseDbId, undefined, {
      token: { uid: 'X-1', type: 'RFID', ...fields },
    });

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('refuses an over-long authorization_reference', async () => {
    const res = await startSession(EVSE.evseDbId, undefined, {
      authorization_reference: 'x'.repeat(37),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().status_code).toBe(2001);
  });

  it('rejects a private response_url unless the partner has the private-network flag', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [PUSHED_RFID, [{ siteId: 'sit_000000000001' }], []];
    const refused = await startSession(EVSE.evseDbId, 'http://127.0.0.1:7105/commands/1');
    expect(refused.json().status_code).not.toBe(1000);
    expect(mockDispatch).not.toHaveBeenCalled();

    partnerFlags.allowPrivateNetwork = true;
    dbResults = [PUSHED_RFID, [{ siteId: 'sit_000000000001' }], []];
    const accepted = await startSession(EVSE.evseDbId, 'http://127.0.0.1:7105/commands/1');
    expect(accepted.json().data.result).toBe('ACCEPTED');
  });

  it('rejects an EVSE uid that belongs to another site', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, siteId: 'sit_000000000009' });
    dbResults = [PUSHED_RFID, [{ siteId: 'sit_000000000001' }], []];

    const res = await startSession(EVSE.evseDbId);

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it.each(UNAVAILABLE_STATES)('rejects a station-level unavailable station %o', async (state) => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, stationState: state });
    dbResults = [PUSHED_RFID, [{ siteId: 'sit_000000000001' }], []];

    const res = await startSession(EVSE.evseDbId);

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects a station under maintenance', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [
      PUSHED_RFID,
      [{ siteId: 'sit_000000000001' }],
      [{ affectedStationIds: [EVSE.stationDbId] }],
    ];

    const res = await startSession(EVSE.evseDbId);

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('without an EVSE uid, skips a disabled station and starts on the next one', async () => {
    dbResults = [
      PUSHED_RFID,
      [{ siteId: 'sit_000000000001' }],
      [], // maintenance events
      [stationRow(1, DISABLED), stationRow(2)], // stations at the site
    ];

    const res = await startSession();

    expect(res.json().data.result).toBe('ACCEPTED');
    expect(mockFindEvseByUid).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith(
      'cmd-1',
      'CS-0002',
      'RequestStartTransaction',
      expect.not.objectContaining({ evseId: expect.anything() }),
    );
  });

  it('without an EVSE uid, skips an offline station and starts on an online one', async () => {
    dbResults = [
      PUSHED_RFID,
      [{ siteId: 'sit_000000000001' }],
      [],
      [stationRow(1, AVAILABLE, false), stationRow(2)],
    ];

    const res = await startSession();

    expect(res.json().data.result).toBe('ACCEPTED');
    expect(mockDispatch).toHaveBeenCalledWith(
      'cmd-1',
      'CS-0002',
      'RequestStartTransaction',
      expect.anything(),
    );
  });

  it('without an EVSE uid, rejects when every station is offline', async () => {
    dbResults = [
      PUSHED_RFID,
      [{ siteId: 'sit_000000000001' }],
      [],
      [stationRow(1, AVAILABLE, false), stationRow(2, AVAILABLE, false)],
    ];

    const res = await startSession();

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('without an EVSE uid, skips a station under maintenance', async () => {
    dbResults = [
      PUSHED_RFID,
      [{ siteId: 'sit_000000000001' }],
      [{ affectedStationIds: ['sta_000000000001'] }],
      [stationRow(1), stationRow(2)],
    ];

    const res = await startSession();

    expect(res.json().data.result).toBe('ACCEPTED');
    expect(mockDispatch).toHaveBeenCalledWith(
      'cmd-1',
      'CS-0002',
      'RequestStartTransaction',
      expect.anything(),
    );
  });

  it('without an EVSE uid, rejects when no station at the site can start', async () => {
    dbResults = [
      PUSHED_RFID,
      [{ siteId: 'sit_000000000001' }],
      [],
      [stationRow(1, DISABLED), stationRow(2, FAULTED)],
    ];

    const res = await startSession();

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('without an EVSE uid, rejects a site with no stations', async () => {
    dbResults = [PUSHED_RFID, [{ siteId: 'sit_000000000001' }], [], []];

    const res = await startSession();

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('OCPI RESERVE_NOW', () => {
  // Owner decision: partner reservations are not supported, like CANCEL_RESERVATION.
  it('answers REJECTED without dispatching', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [PUSHED_RFID, [{ siteId: 'sit_000000000001' }], []];

    const res = await reserveNow(EVSE.evseDbId);

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });
});

describe('OCPI UNLOCK_CONNECTOR', () => {
  function unlock() {
    return app.inject({
      method: 'POST',
      url: '/ocpi/2.2.1/cpo/commands/UNLOCK_CONNECTOR',
      payload: {
        response_url: 'https://partner.example.com/commands/3',
        location_id: 'sit_000000000001',
        evse_uid: EVSE.evseDbId,
        connector_id: '1',
      },
    });
  }

  const OWN_ACTIVE = [{ status: 'active', endedAt: null, linkPartnerId: 'opr_000000000001' }];

  it('unlocks the connector on the EVSE owner station', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: 'sit_000000000001' }], [{ connectorId: 1 }], OWN_ACTIVE];

    const res = await unlock();

    expect(res.json().data.result).toBe('ACCEPTED');
    expect(mockDispatch).toHaveBeenCalledWith('cmd-1', 'CS-0002', 'UnlockConnector', {
      evseId: 1,
      connectorId: 1,
    });
  });

  it('unlocks shortly after the partner session ended', async () => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [
      [{ siteId: 'sit_000000000001' }],
      [{ connectorId: 1 }],
      [{ status: 'completed', endedAt: new Date(), linkPartnerId: 'opr_000000000001' }],
    ];

    const res = await unlock();

    expect(res.json().data.result).toBe('ACCEPTED');
  });

  it.each([
    ['another partner session', [{ status: 'active', endedAt: null, linkPartnerId: 'opr_9' }]],
    ['a local driver session', [{ status: 'active', endedAt: null, linkPartnerId: null }]],
    [
      'a partner session that ended long ago',
      [
        {
          status: 'completed',
          endedAt: new Date(Date.now() - 2 * 60 * 60_000),
          linkPartnerId: 'opr_000000000001',
        },
      ],
    ],
    ['no session', []],
  ])('rejects an unlock over %s', async (_name, latest) => {
    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: 'sit_000000000001' }], [{ connectorId: 1 }], latest];

    const res = await unlock();

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects an offline station or an unknown connector', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, stationOnline: false });
    dbResults = [[{ siteId: 'sit_000000000001' }]];
    expect((await unlock()).json().data.result).toBe('REJECTED');

    mockFindEvseByUid.mockResolvedValue(EVSE);
    dbResults = [[{ siteId: 'sit_000000000001' }], []];
    expect((await unlock()).json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('rejects an EVSE uid that belongs to another site', async () => {
    mockFindEvseByUid.mockResolvedValue({ ...EVSE, siteId: 'sit_000000000009' });
    dbResults = [[{ siteId: 'sit_000000000001' }]];

    const res = await unlock();

    expect(res.json().data.result).toBe('REJECTED');
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
