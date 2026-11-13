// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Per-station AI insight suppression: suppressing (audit, actions expired,
// insights dismissed), the suppressor's name, and the resume branches.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  sets: [] as Record<string, unknown>[],
}));

vi.mock('@evtivity/database', () => {
  function chain(): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'returning']) c[m] = () => c;
    c['set'] = (arg: Record<string, unknown>) => {
      state.sets.push(arg);
      return c;
    };
    c['then'] = (resolve: (v: unknown) => void) => {
      resolve(state.results.shift() ?? []);
    };
    return c;
  }
  return {
    db: { select: () => chain(), update: () => chain() },
    writeAudit: vi.fn(() => Promise.resolve()),
    chargingStations: { id: 'cs.id' },
    stationAuditLog: { name: 'station_audit_log' },
    users: { id: 'users.id' },
    stationSiteInsightsSuppressedSql: (a: string) => `site_suppressed(${a})`,
  };
});
vi.mock('drizzle-orm', () => {
  const sql = Object.assign(() => ({ sql: true }), { raw: (s: string) => s });
  return { and: (...c: unknown[]) => ({ and: c }), eq: () => ({ eq: true }), sql };
});
vi.mock('@evtivity/lib/pubsub-instance', () => ({ getPubSub: () => ({ pubsub: 1 }) }));
vi.mock('@evtivity/services/ai-insight.service', () => ({
  dismissStationInsights: vi.fn(() => Promise.resolve(['ain_1', 'ain_2'])),
}));
vi.mock('@evtivity/services/ai-proposal.service', () => ({
  expireStationAiProposals: vi.fn(() => Promise.resolve(3)),
}));

import { writeAudit } from '@evtivity/database';
import { dismissStationInsights } from '@evtivity/services/ai-insight.service';
import { expireStationAiProposals } from '@evtivity/services/ai-proposal.service';
import {
  resumeStationAiInsights,
  suppressStationAiInsights,
} from '../services/station-ai-insights.service.js';

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;
const actor = {
  actor: 'operator' as const,
  actorUserId: 'usr_1',
  actorDriverId: null,
  actorApiKeyId: 'key_1',
  actorLabel: 'Ada',
};
const free = { suppressedAt: null, suppressedUntil: null, suppressedBy: null, reason: null };
const held = {
  suppressedAt: new Date('2026-10-15T10:00:00Z'),
  suppressedUntil: null,
  suppressedBy: 'usr_1',
  reason: 'Rebuild',
};

beforeEach(() => {
  state.results = [];
  state.sets = [];
});

describe('suppressStationAiInsights', () => {
  it('answers null for an unknown station and writes nothing', async () => {
    state.results.push([]);
    expect(
      await suppressStationAiInsights('sta_x', { reason: 'r', until: null }, actor, log),
    ).toBeNull();
    expect(state.sets).toEqual([]);
  });

  it('suppresses, audits, closes actions and insights and names the suppressor', async () => {
    const until = new Date('2030-01-01T00:00:00Z');
    state.results.push([free], [], [held], [{ firstName: 'Ada', lastName: null }]);
    const result = await suppressStationAiInsights(
      'sta_1',
      { reason: 'Rebuild', until },
      actor,
      log,
    );
    expect(state.sets[0]).toMatchObject({
      aiInsightsSuppressedAt: expect.any(Date),
      aiInsightsSuppressedUntil: until,
      aiInsightsSuppressedBy: 'usr_1',
      aiInsightsSuppressedReason: 'Rebuild',
    });
    expect(writeAudit).toHaveBeenCalledWith(
      { table: { name: 'station_audit_log' }, idColumn: 'station_id' },
      expect.objectContaining({
        entityId: 'sta_1',
        notes: 'AI insights suppressed',
        before: {
          aiInsightsSuppressedAt: null,
          aiInsightsSuppressedUntil: null,
          aiInsightsSuppressedReason: null,
        },
        after: { aiInsightsSuppressedUntil: until, aiInsightsSuppressedReason: 'Rebuild' },
      }),
      expect.anything(),
      log,
    );
    expect(expireStationAiProposals).toHaveBeenCalledWith(
      'sta_1',
      'Rebuild',
      { actor: 'operator', actorUserId: 'usr_1', actorLabel: 'Ada' },
      log,
    );
    expect(dismissStationInsights).toHaveBeenCalledWith(
      'sta_1',
      'Rebuild',
      { actor: 'operator', actorUserId: 'usr_1', actorApiKeyId: 'key_1' },
      { pubsub: 1 },
    );
    expect(result).toEqual({
      ...held,
      suppressedByName: 'Ada',
      insightsDismissed: 2,
      actionsExpired: 3,
    });
  });

  it('answers null when the station is gone after the suppression', async () => {
    state.results.push([free], [], []);
    expect(
      await suppressStationAiInsights('sta_1', { reason: 'r', until: null }, actor, log),
    ).toBeNull();
  });

  it('names nobody for a suppressor without a name or a deleted user', async () => {
    state.results.push([free], [], [held], [{ firstName: null, lastName: null }]);
    const r1 = await suppressStationAiInsights('sta_1', { reason: 'r', until: null }, actor, log);
    expect(r1?.suppressedByName).toBeNull();
    state.results.push([free], [], [held], []);
    const r2 = await suppressStationAiInsights('sta_1', { reason: 'r', until: null }, actor, log);
    expect(r2?.suppressedByName).toBeNull();
  });
});

describe('resumeStationAiInsights', () => {
  it('answers null for an unknown station', async () => {
    state.results.push([]);
    expect(await resumeStationAiInsights('sta_x', actor, log)).toBeNull();
  });

  it('keeps a station of a suppressed site', async () => {
    state.results.push([free], [{ suppressed: true }]);
    expect(await resumeStationAiInsights('sta_1', actor, log)).toBe('site_suppressed');
    expect(state.sets).toEqual([]);
  });

  it('returns a station that is not suppressed unchanged', async () => {
    state.results.push([free], [{ suppressed: false }]);
    expect(await resumeStationAiInsights('sta_1', actor, log)).toEqual({
      ...free,
      suppressedByName: null,
    });
    expect(state.sets).toEqual([]);
    // A missing site row reads as not suppressed.
    state.results.push([free], []);
    expect(await resumeStationAiInsights('sta_1', actor, log)).toEqual({
      ...free,
      suppressedByName: null,
    });
  });

  it('answers site_suppressed when the site was suppressed before the write', async () => {
    state.results.push([held], [{ firstName: 'Ada', lastName: 'L' }], [{ suppressed: false }], []);
    expect(await resumeStationAiInsights('sta_1', actor, log)).toBe('site_suppressed');
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it('resumes, audits and returns the cleared state', async () => {
    state.results.push(
      [held],
      [{ firstName: 'Ada', lastName: 'L' }],
      [{ suppressed: false }],
      [{ id: 'sta_1' }],
      [free],
    );
    expect(await resumeStationAiInsights('sta_1', actor, log)).toEqual({
      ...free,
      suppressedByName: null,
    });
    expect(state.sets[0]).toEqual({
      aiInsightsSuppressedAt: null,
      aiInsightsSuppressedUntil: null,
      aiInsightsSuppressedBy: null,
      aiInsightsSuppressedReason: null,
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        notes: 'AI insights resumed',
        before: expect.objectContaining({ aiInsightsSuppressedReason: 'Rebuild' }),
        after: { aiInsightsSuppressedAt: null, aiInsightsSuppressedUntil: null },
      }),
      expect.anything(),
      log,
    );
  });
});
