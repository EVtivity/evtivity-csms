// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import * as chargingProfileReconciliationModule from '../../handlers/charging-profile-reconciliation.js';

// Drizzle chain mock. Each query chain (selectDistinct().from().where() or
// select().from().where().orderBy()) resolves to the next queued result.
// Order of queries in the handler:
//   1. selectDistinct stationsWithProfiles
//   2. select csmsRows
//   3. select reportedRows
//   4. select station sites (for the SSE event's siteId)
let queryResults: unknown[][] = [];
let queryIndex = 0;
function setupQueries(...results: unknown[][]): void {
  queryResults = results;
  queryIndex = 0;
}
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy']) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
    if (!awaited) {
      awaited = true;
      const r = queryResults[queryIndex] ?? [];
      queryIndex++;
      return Promise.resolve(r).then(resolve, reject);
    }
    return Promise.resolve([]).then(resolve, reject);
  };
  return chain;
}

vi.mock('@evtivity/database', () => ({
  db: {
    selectDistinct: vi.fn(() => makeChain()),
    select: vi.fn(() => makeChain()),
  },
  chargingProfiles: {
    stationId: 'chargingProfiles.stationId',
    evseId: 'chargingProfiles.evseId',
    profileData: 'chargingProfiles.profileData',
    source: 'chargingProfiles.source',
    sentAt: 'chargingProfiles.sentAt',
    reportedAt: 'chargingProfiles.reportedAt',
  },
  chargingStations: {
    id: 'chargingStations.id',
    siteId: 'chargingStations.siteId',
    ocppProtocol: 'chargingStations.ocppProtocol',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: (strings: TemplateStringsArray) => ({ __sql: strings.join('') }),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockGetPubSub = vi.fn(() => ({ publish: mockPublish }));
vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => mockGetPubSub(),
}));

function makeLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('chargingProfileReconciliationHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupQueries();
  });

  it('returns early when no stations have csms_set profiles', async () => {
    setupQueries([]); // selectDistinct -> none
    const { chargingProfileReconciliationHandler } = chargingProfileReconciliationModule;

    await chargingProfileReconciliationHandler(makeLog());

    expect(mockGetPubSub).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes a profileMismatch event when the station never reported a matching profile', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }], // stationsWithProfiles
      [{ stationId: 'sta_1', evseId: 1, profileData: { id: 5, stackLevel: 0 } }], // csmsRows
      [], // reportedRows: nothing reported
      [{ id: 'sta_1', siteId: 'sit_1', ocppProtocol: 'ocpp2.1' }], // station sites
    );
    const log = makeLog();
    const { chargingProfileReconciliationHandler } = chargingProfileReconciliationModule;

    await chargingProfileReconciliationHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({
        eventType: 'station.profileMismatch',
        stationId: 'sta_1',
        sessionId: null,
        siteId: 'sit_1',
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      { mismatchCount: 1 },
      'Charging profile mismatches detected',
    );
  });

  it('matches a profile the station reports in its report array by id', async () => {
    // The stored copy is one object, the station report an array whose fields
    // the station renders its own way: comparing the JSON flagged every station.
    setupQueries(
      [{ stationId: 'sta_1' }],
      [{ stationId: 'sta_1', evseId: 0, profileData: { id: 5, stackLevel: 0, limit: 32 } }],
      [
        {
          stationId: 'sta_1',
          evseId: 0,
          profileData: [{ id: 4 }, { id: 5, stackLevel: 0, limit: 32.0, extra: true }],
        },
      ],
      [{ id: 'sta_1', siteId: 'sit_1', ocppProtocol: 'ocpp2.1' }],
    );
    const log = makeLog();
    const { chargingProfileReconciliationHandler } = chargingProfileReconciliationModule;

    await chargingProfileReconciliationHandler(log);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('reads the id of a profile stored in 1.6 form', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }],
      [{ stationId: 'sta_1', evseId: 1, profileData: { chargingProfileId: 9 } }],
      [{ stationId: 'sta_1', evseId: 1, profileData: [{ id: 9 }] }],
      [{ id: 'sta_1', siteId: 'sit_1', ocppProtocol: 'ocpp2.1' }],
    );
    const { chargingProfileReconciliationHandler } = chargingProfileReconciliationModule;

    await chargingProfileReconciliationHandler(makeLog());

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('skips OCPP 1.6 stations, which cannot report their profiles', async () => {
    setupQueries(
      [{ stationId: 'sta_16' }],
      [{ stationId: 'sta_16', evseId: 1, profileData: { id: 3 } }],
      [],
      [{ id: 'sta_16', siteId: 'sit_1', ocppProtocol: 'ocpp1.6' }],
    );
    const { chargingProfileReconciliationHandler } = chargingProfileReconciliationModule;

    await chargingProfileReconciliationHandler(makeLog());

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('groups rows by station so one station mismatch does not leak into another station', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }, { stationId: 'sta_2' }],
      [
        { stationId: 'sta_1', evseId: 1, profileData: { id: 1 } },
        { stationId: 'sta_2', evseId: 1, profileData: { id: 2 } },
      ],
      [{ stationId: 'sta_1', evseId: 1, profileData: [{ id: 1 }] }],
      [
        { id: 'sta_1', siteId: 'sit_1', ocppProtocol: 'ocpp2.1' },
        { id: 'sta_2', siteId: 'sit_1', ocppProtocol: 'ocpp2.1' },
      ],
    );
    const { chargingProfileReconciliationHandler } = chargingProfileReconciliationModule;

    await chargingProfileReconciliationHandler(makeLog());

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'csms_events',
      expect.stringContaining('"stationId":"sta_2"'),
    );
  });

  it('swallows a pubsub publish failure so the reconciliation loop is not aborted (fail-open)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('redis down'));
    setupQueries(
      [{ stationId: 'sta_1' }, { stationId: 'sta_2' }],
      [
        { stationId: 'sta_1', evseId: 1, profileData: { id: 1 } },
        { stationId: 'sta_2', evseId: 1, profileData: { id: 2 } },
      ],
      [],
      [
        { id: 'sta_1', siteId: 'sit_1', ocppProtocol: 'ocpp2.1' },
        { id: 'sta_2', siteId: 'sit_1', ocppProtocol: 'ocpp2.1' },
      ],
    );
    const { chargingProfileReconciliationHandler } = chargingProfileReconciliationModule;

    await expect(chargingProfileReconciliationHandler(makeLog())).resolves.toBeUndefined();
    // First publish rejected, second still attempted.
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});
