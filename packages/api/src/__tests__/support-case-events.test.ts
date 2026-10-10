// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishMock = vi.fn(async () => undefined);

// Results of the db lookups in call order: the case's station and site, then
// (for a case without a station) the sites of its linked sessions.
// An Error entry makes that lookup fail.
const lookup = vi.hoisted(() => ({ queue: [] as Array<unknown[] | Error> }));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: (): { publish: typeof publishMock } => ({ publish: publishMock }),
}));

vi.mock('@evtivity/database', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'leftJoin']) chain[m] = vi.fn(() => chain);
  chain['where'] = vi.fn(() => {
    const next = lookup.queue.shift() ?? [];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return {
    db: chain,
    supportCases: { id: 'support_cases.id', stationId: 'support_cases.station_id' },
    supportCaseSessions: {
      caseId: 'support_case_sessions.case_id',
      sessionId: 'support_case_sessions.session_id',
    },
    chargingSessions: { id: 'charging_sessions.id', stationId: 'charging_sessions.station_id' },
    chargingStations: { id: 'charging_stations.id', siteId: 'charging_stations.site_id' },
  };
});

import { notifySupportCaseEvent } from '../lib/support-case-events.js';

function csmsPayload(): unknown {
  const call = publishMock.mock.calls.find((c) => (c as unknown[])[0] === 'csms_events') as
    | unknown[]
    | undefined;
  return JSON.parse(call?.[1] as string);
}

beforeEach(() => {
  publishMock.mockClear();
  lookup.queue = [];
});

describe('notifySupportCaseEvent', () => {
  it('logs and resolves when the lookup fails, publishing nothing', async () => {
    lookup.queue = [new Error('db down')];
    await expect(
      notifySupportCaseEvent('supportCase.updated', 'cas_1', 'drv_9'),
    ).resolves.toBeUndefined();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('logs and resolves when the publish fails', async () => {
    lookup.queue = [[{ stationId: 'sta_1', siteId: 'sit_1' }]];
    publishMock.mockImplementationOnce(() => Promise.reject(new Error('redis down')));
    await expect(
      notifySupportCaseEvent('supportCase.updated', 'cas_1', 'drv_9'),
    ).resolves.toBeUndefined();
  });

  it('publishes to csms_events with the case station and site, and to portal_events', async () => {
    lookup.queue = [[{ stationId: 'sta_1', siteId: 'sit_1' }]];
    await notifySupportCaseEvent('supportCase.created', 'cas_1', 'drv_9');

    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenNthCalledWith(
      1,
      'csms_events',
      JSON.stringify({
        eventType: 'supportCase.created',
        caseId: 'cas_1',
        stationId: 'sta_1',
        siteId: 'sit_1',
        caseSiteIds: null,
      }),
    );
    expect(publishMock).toHaveBeenNthCalledWith(
      2,
      'portal_events',
      JSON.stringify({ type: 'supportCase.created', caseId: 'cas_1', driverId: 'drv_9' }),
    );
  });

  it('carries the distinct sites of the linked sessions for a case without a station', async () => {
    lookup.queue = [
      [{ stationId: null, siteId: null }],
      [{ siteId: 'sit_a' }, { siteId: 'sit_b' }, { siteId: 'sit_a' }],
    ];
    await notifySupportCaseEvent('supportCase.updated', 'cas_2', null);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(csmsPayload()).toEqual({
      eventType: 'supportCase.updated',
      caseId: 'cas_2',
      stationId: null,
      siteId: null,
      caseSiteIds: ['sit_a', 'sit_b'],
    });
  });

  it('sends null caseSiteIds when a linked session ran at an unsited station', async () => {
    lookup.queue = [[{ stationId: null, siteId: null }], [{ siteId: 'sit_a' }, { siteId: null }]];
    await notifySupportCaseEvent('supportCase.updated', 'cas_4', null);

    expect(csmsPayload()).toMatchObject({ caseSiteIds: null });
  });

  it('publishes without a station, site or case sites when the case is missing', async () => {
    await notifySupportCaseEvent('supportCase.newMessage', 'cas_3', 'drv_3');

    expect(csmsPayload()).toEqual({
      eventType: 'supportCase.newMessage',
      caseId: 'cas_3',
      stationId: null,
      siteId: null,
      caseSiteIds: null,
    });
    expect(publishMock).toHaveBeenNthCalledWith(
      2,
      'portal_events',
      JSON.stringify({ type: 'supportCase.newMessage', caseId: 'cas_3', driverId: 'drv_3' }),
    );
  });
});
