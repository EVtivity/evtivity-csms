// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// Each awaited db chain consumes the next queued result; `set` arguments are recorded.
let results: unknown[] = [];
const sets: Record<string, unknown>[] = [];

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'returning']) c[m] = vi.fn(() => c);
  c['set'] = vi.fn((arg: Record<string, unknown>) => {
    sets.push(arg);
    return c;
  });
  c['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);
  return c;
}

vi.mock('@evtivity/database', async () => ({
  ...(await import('@evtivity/database/src/lib/ai-insight-suppression.js')),
  db: { select: vi.fn(() => chain()), update: vi.fn(() => chain()) },
  writeAudit: vi.fn().mockResolvedValue(undefined),
  sites: { id: 'sites.id' },
  chargingStations: { id: 'charging_stations.id' },
  siteAuditLog: { name: 'site_audit_log' },
  stationAuditLog: { name: 'station_audit_log' },
  users: { id: 'users.id' },
}));
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: vi.fn(() => ({})) }));
vi.mock('@evtivity/services/ai-insight.service', () => ({
  dismissSiteInsights: vi.fn().mockResolvedValue(['ain_1', 'ain_2']),
  dismissStationInsights: vi.fn().mockResolvedValue([]),
}));
vi.mock('@evtivity/services/ai-proposal.service', () => ({
  expireSiteAiProposals: vi.fn().mockResolvedValue(1),
  expireStationAiProposals: vi.fn().mockResolvedValue(0),
}));

import { writeAudit } from '@evtivity/database';
import { dismissSiteInsights } from '@evtivity/services/ai-insight.service';
import { expireSiteAiProposals } from '@evtivity/services/ai-proposal.service';
import {
  resumeSiteAiInsights,
  suppressSiteAiInsights,
} from '../services/site-ai-insights.service.js';
import { resumeStationAiInsights } from '../services/station-ai-insights.service.js';

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;
const actor = {
  actor: 'operator' as const,
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: null,
  actorLabel: 'Ada Lovelace',
};
const inScope = { suppressedAt: null, suppressedUntil: null, suppressedBy: null, reason: null };
const held = {
  suppressedAt: new Date('2026-10-15T10:00:00Z'),
  suppressedUntil: null,
  suppressedBy: 'usr_1',
  reason: 'Rebuild',
};

beforeEach(() => {
  vi.clearAllMocks();
  results = [];
  sets.length = 0;
});

describe('site AI insight suppression service', () => {
  it('suppresses the site, audits it, expires the actions and dismisses the insights', async () => {
    const until = new Date('2030-01-01T00:00:00Z');
    // current (before), update, current (after) with its user name.
    results = [
      [inScope],
      [],
      [{ ...held, suppressedUntil: until }],
      [{ firstName: 'Ada', lastName: 'Lovelace' }],
    ];
    const result = await suppressSiteAiInsights('sit_1', { reason: 'Rebuild', until }, actor, log);
    expect(sets[0]).toMatchObject({
      aiInsightsSuppressedUntil: until,
      aiInsightsSuppressedBy: 'usr_1',
      aiInsightsSuppressedReason: 'Rebuild',
    });
    expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
      entityId: 'sit_1',
      action: 'updated',
      notes: 'AI insights suppressed',
    });
    expect(expireSiteAiProposals).toHaveBeenCalledWith('sit_1', 'Rebuild', expect.any(Object), log);
    expect(dismissSiteInsights).toHaveBeenCalledWith('sit_1', 'Rebuild', expect.any(Object), {});
    expect(result).toMatchObject({
      suppressedByName: 'Ada Lovelace',
      insightsDismissed: 2,
      actionsExpired: 1,
    });
  });

  it('returns null for an unknown site and writes nothing', async () => {
    results = [[]];
    expect(
      await suppressSiteAiInsights('sit_x', { reason: 'R', until: null }, actor, log),
    ).toBeNull();
    expect(sets).toEqual([]);
    expect(dismissSiteInsights).not.toHaveBeenCalled();
  });

  it('resumes a suppressed site and leaves a site in scope untouched', async () => {
    results = [[held], [{ firstName: 'Ada', lastName: 'Lovelace' }], [], [inScope]];
    const resumed = await resumeSiteAiInsights('sit_1', actor, log);
    expect(sets[0]).toEqual({
      aiInsightsSuppressedAt: null,
      aiInsightsSuppressedUntil: null,
      aiInsightsSuppressedBy: null,
      aiInsightsSuppressedReason: null,
    });
    expect(resumed?.suppressedAt).toBeNull();
    expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
      notes: 'AI insights resumed',
    });

    vi.clearAllMocks();
    sets.length = 0;
    results = [[inScope]];
    await resumeSiteAiInsights('sit_1', actor, log);
    expect(sets).toEqual([]);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('station AI insight resume under a suppressed site', () => {
  it('refuses while the site of the station is suppressed and changes nothing', async () => {
    // current (before) with its user name, then the site check.
    results = [[held], [{ firstName: 'Ada', lastName: 'Lovelace' }], [{ suppressed: true }]];
    expect(await resumeStationAiInsights('sta_1', actor, log)).toBe('site_suppressed');
    expect(sets).toEqual([]);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('refuses when the site is suppressed between the check and the write', async () => {
    results = [[held], [{ firstName: 'Ada', lastName: 'Lovelace' }], [{ suppressed: false }], []];
    expect(await resumeStationAiInsights('sta_1', actor, log)).toBe('site_suppressed');
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('resumes when the site is in scope', async () => {
    results = [
      [held],
      [{ firstName: 'Ada', lastName: 'Lovelace' }],
      [{ suppressed: false }],
      [{ id: 'sta_1' }],
      [inScope],
    ];
    const resumed = await resumeStationAiInsights('sta_1', actor, log);
    expect(resumed).toMatchObject({ suppressedAt: null });
    expect(vi.mocked(writeAudit).mock.calls[0]?.[1]).toMatchObject({
      notes: 'AI insights resumed',
    });
  });
});
