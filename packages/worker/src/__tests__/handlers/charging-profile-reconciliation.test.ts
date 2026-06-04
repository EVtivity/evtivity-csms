// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// Drizzle chain mock. Each query chain (selectDistinct().from().where() or
// select().from().where().orderBy()) resolves to the next queued result.
// Order of queries in the handler:
//   1. selectDistinct stationsWithProfiles
//   2. select csmsRows
//   3. select reportedRows
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
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: (strings: TemplateStringsArray) => ({ __sql: strings.join('') }),
}));

const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockGetPubSub = vi.fn(() => ({ publish: mockPublish }));
vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
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
    const { chargingProfileReconciliationHandler } =
      await import('../../handlers/charging-profile-reconciliation.js');

    await chargingProfileReconciliationHandler(makeLog());

    expect(mockGetPubSub).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes a profileMismatch event when the station never reported a matching profile', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }], // stationsWithProfiles
      [{ stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } }], // csmsRows
      [], // reportedRows: nothing reported
    );
    const log = makeLog();
    const { chargingProfileReconciliationHandler } =
      await import('../../handlers/charging-profile-reconciliation.js');

    await chargingProfileReconciliationHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'csms_events',
      JSON.stringify({
        eventType: 'station.profileMismatch',
        stationId: 'sta_1',
        sessionId: null,
        siteId: null,
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      { mismatchCount: 1 },
      'Charging profile mismatches detected',
    );
  });

  it('publishes a mismatch when reported profile data differs from the csms-set profile', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }],
      [{ stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } }],
      [{ stationId: 'sta_1', evseId: 1, profileData: { limit: 16 } }], // differs
    );
    const { chargingProfileReconciliationHandler } =
      await import('../../handlers/charging-profile-reconciliation.js');

    await chargingProfileReconciliationHandler(makeLog());

    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('does NOT publish when reported profile data matches the csms-set profile', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }],
      [{ stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } }],
      [{ stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } }], // identical
    );
    const log = makeLog();
    const { chargingProfileReconciliationHandler } =
      await import('../../handlers/charging-profile-reconciliation.js');

    await chargingProfileReconciliationHandler(log);

    expect(mockPublish).not.toHaveBeenCalled();
    // No mismatches -> the summary log line is skipped.
    expect(log.info).not.toHaveBeenCalled();
  });

  it('uses only the first (most recent) profile per evse and ignores stale duplicates', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }],
      [
        { stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } }, // newest, kept
        { stationId: 'sta_1', evseId: 1, profileData: { limit: 99 } }, // stale, ignored
      ],
      [
        { stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } }, // newest, matches
        { stationId: 'sta_1', evseId: 1, profileData: { limit: 1 } }, // stale, ignored
      ],
    );
    const { chargingProfileReconciliationHandler } =
      await import('../../handlers/charging-profile-reconciliation.js');

    await chargingProfileReconciliationHandler(makeLog());

    // Newest-vs-newest match -> no mismatch.
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('groups rows by station so one station mismatch does not leak into another station', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }, { stationId: 'sta_2' }],
      [
        { stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } },
        { stationId: 'sta_2', evseId: 1, profileData: { limit: 10 } },
      ],
      [
        { stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } }, // matches
        // sta_2 not reported -> mismatch
      ],
    );
    const { chargingProfileReconciliationHandler } =
      await import('../../handlers/charging-profile-reconciliation.js');

    await chargingProfileReconciliationHandler(makeLog());

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'csms_events',
      expect.stringContaining('"stationId":"sta_2"'),
    );
  });

  it('counts every mismatched evse and reports the total', async () => {
    setupQueries(
      [{ stationId: 'sta_1' }],
      [
        { stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } },
        { stationId: 'sta_1', evseId: 2, profileData: { limit: 16 } },
      ],
      [], // neither reported
    );
    const log = makeLog();
    const { chargingProfileReconciliationHandler } =
      await import('../../handlers/charging-profile-reconciliation.js');

    await chargingProfileReconciliationHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      { mismatchCount: 2 },
      'Charging profile mismatches detected',
    );
  });

  it('swallows a pubsub publish failure so the reconciliation loop is not aborted (fail-open)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('redis down'));
    setupQueries(
      [{ stationId: 'sta_1' }],
      [
        { stationId: 'sta_1', evseId: 1, profileData: { limit: 32 } },
        { stationId: 'sta_1', evseId: 2, profileData: { limit: 16 } },
      ],
      [], // both mismatch
    );
    const { chargingProfileReconciliationHandler } =
      await import('../../handlers/charging-profile-reconciliation.js');

    await expect(chargingProfileReconciliationHandler(makeLog())).resolves.toBeUndefined();
    // First publish rejected, second still attempted.
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });
});
