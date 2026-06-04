// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';

// -- DB mock helpers --

let dbResults: unknown[][] = [];
let dbCallIndex = 0;

function setupDbResults(...results: unknown[][]): void {
  dbResults = results;
  dbCallIndex = 0;
}

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const methods = [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'innerJoin',
    'leftJoin',
    'groupBy',
  ];
  for (const m of methods) {
    chain[m] = vi.fn(() => chain);
  }
  let awaited = false;
  chain['then'] = (
    onFulfilled?: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ): Promise<unknown> => {
    if (!awaited) {
      awaited = true;
      const result = dbResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    return Promise.resolve([]).then(onFulfilled, onRejected);
  };
  chain['catch'] = (onRejected?: (r: unknown) => unknown): Promise<unknown> =>
    Promise.resolve([]).catch(onRejected);
  return chain;
}

// -- Hoisted mocks --

const { mockIsStationMessageEnabled, mockGetStationMessageRefreshSeconds, mockPublish } =
  vi.hoisted(() => ({
    mockIsStationMessageEnabled: vi.fn(),
    mockGetStationMessageRefreshSeconds: vi.fn(),
    mockPublish: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@evtivity/database', () => ({
  db: {
    select: vi.fn(() => makeChain()),
  },
  chargingSessions: {
    id: 'id',
    stationId: 'stationId',
    status: 'status',
  },
  chargingStations: {
    id: 'id',
    stationId: 'stationId',
    ocppProtocol: 'ocppProtocol',
  },
  stationMessagePushes: {
    stationId: 'stationId',
    ocppMessageId: 'ocppMessageId',
    pushedAt: 'pushedAt',
  },
  isStationMessageEnabled: mockIsStationMessageEnabled,
  getStationMessageRefreshSeconds: mockGetStationMessageRefreshSeconds,
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(
    vi.fn(() => ({})),
    { raw: vi.fn() },
  ),
}));

vi.mock('@evtivity/api/src/lib/pubsub.js', () => ({
  getPubSub: () => ({ publish: mockPublish }),
}));

// -- Import under test --

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('stationMessageChargingRefreshHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDbResults();
    mockIsStationMessageEnabled.mockResolvedValue(true);
    mockGetStationMessageRefreshSeconds.mockResolvedValue(30);
    mockPublish.mockResolvedValue(undefined);
  });

  it('returns early when station messages are disabled', async () => {
    mockIsStationMessageEnabled.mockResolvedValueOnce(false);

    const { stationMessageChargingRefreshHandler } =
      await import('../../handlers/station-message-charging-refresh.js');
    await stationMessageChargingRefreshHandler(log);

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes one transaction event per active OCPP 2.1 session', async () => {
    setupDbResults(
      [
        {
          sessionId: 'ses_1',
          stationUuid: 'sta_1',
          stationOcppId: 'CS-0001',
          ocppProtocol: 'ocpp2.1',
        },
        {
          sessionId: 'ses_2',
          stationUuid: 'sta_2',
          stationOcppId: 'CS-0002',
          ocppProtocol: 'ocpp2.1',
        },
      ],
      [],
    );

    const { stationMessageChargingRefreshHandler } =
      await import('../../handlers/station-message-charging-refresh.js');
    await stationMessageChargingRefreshHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(2);
    const events = mockPublish.mock.calls.map((c) => {
      const body = JSON.parse(c[1] as string) as {
        sessionId: string;
        eventType: string;
        chargingState: string;
      };
      return body;
    });
    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 'ses_1',
        eventType: 'updated',
        chargingState: 'Charging',
      }),
      expect.objectContaining({
        sessionId: 'ses_2',
        eventType: 'updated',
        chargingState: 'Charging',
      }),
    ]);
  });

  it('skips sessions whose last push is within the refresh window', async () => {
    const recentPush = new Date(Date.now() - 5_000);
    const olderPush = new Date(Date.now() - 60_000);

    setupDbResults(
      [
        {
          sessionId: 'ses_recent',
          stationUuid: 'sta_recent',
          stationOcppId: 'CS-RECENT',
          ocppProtocol: 'ocpp2.1',
        },
        {
          sessionId: 'ses_old',
          stationUuid: 'sta_old',
          stationOcppId: 'CS-OLD',
          ocppProtocol: 'ocpp2.1',
        },
      ],
      [
        { stationId: 'sta_recent', pushedAt: recentPush },
        { stationId: 'sta_old', pushedAt: olderPush },
      ],
    );

    const { stationMessageChargingRefreshHandler } =
      await import('../../handlers/station-message-charging-refresh.js');
    await stationMessageChargingRefreshHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockPublish.mock.calls[0]![1] as string) as { sessionId: string };
    expect(body.sessionId).toBe('ses_old');
  });

  it('logs a warning and excludes failed publishes from the published count', async () => {
    setupDbResults(
      [
        {
          sessionId: 'ses_ok',
          stationUuid: 'sta_ok',
          stationOcppId: 'CS-OK',
          ocppProtocol: 'ocpp2.1',
        },
        {
          sessionId: 'ses_fail',
          stationUuid: 'sta_fail',
          stationOcppId: 'CS-FAIL',
          ocppProtocol: 'ocpp2.1',
        },
      ],
      [],
    );
    mockPublish.mockImplementation((_channel: string, body: string) => {
      const parsed = JSON.parse(body) as { sessionId: string };
      if (parsed.sessionId === 'ses_fail') {
        return Promise.reject(new Error('redis publish failed'));
      }
      return Promise.resolve(undefined);
    });

    const { stationMessageChargingRefreshHandler } =
      await import('../../handlers/station-message-charging-refresh.js');
    await stationMessageChargingRefreshHandler(log);

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_fail' }),
      'Failed to publish station_message_transaction refresh event',
    );
    // Only the successful publish increments the count; the rejected one is
    // filtered out, so the info log reports exactly one publish.
    expect(log.info).toHaveBeenCalledWith(
      { published: 1 },
      'Station message charging refresh published',
    );
  });

  it('skips the info log when every session is within the refresh window', async () => {
    const recentPush = new Date(Date.now() - 1_000);
    setupDbResults(
      [
        {
          sessionId: 'ses_only',
          stationUuid: 'sta_only',
          stationOcppId: 'CS-ONLY',
          ocppProtocol: 'ocpp2.1',
        },
      ],
      [{ stationId: 'sta_only', pushedAt: recentPush }],
    );

    const { stationMessageChargingRefreshHandler } =
      await import('../../handlers/station-message-charging-refresh.js');
    await stationMessageChargingRefreshHandler(log);

    expect(mockPublish).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('does not publish when there are no active sessions', async () => {
    setupDbResults([]);

    const { stationMessageChargingRefreshHandler } =
      await import('../../handlers/station-message-charging-refresh.js');
    await stationMessageChargingRefreshHandler(log);

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
