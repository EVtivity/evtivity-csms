// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The insight writer and reads (`ai-insight.service.ts`): compare-and-set
// status moves (P5), idempotent inserts (P7), audit rows, published updates,
// cooldowns, watermarks, translations, the list filters and the DTO.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import { opArgs, sqlParams, sqlString } from './helpers/fake-db.js';
import type { AiInsightRow, InsightResult } from '../ai-insight.service.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  audits: [] as Record<string, unknown>[],
  fingerprints: new Map<string, string | null>(),
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    operatorStationSql: (alias: string) => `${alias}.is_operator`,
    siteInsightsSuppressedSql: (alias: string) => `${alias}.suppressed`,
    writeAudit: (_cfg: unknown, args: Record<string, unknown>) => {
      h.audits.push(args);
      return Promise.resolve();
    },
  });
});

vi.mock('../ai-evidence/state.js', () => ({
  currentFingerprints: vi.fn((items: { id: string }[]) =>
    Promise.resolve(new Map(items.map((i) => [i.id, h.fingerprints.get(i.id) ?? null]))),
  ),
}));

const svc = await import('../ai-insight.service.js');

const actor = { actor: 'operator' as const, actorUserId: 'usr_1' };

function pubsub(fail = false) {
  const published: { channel: string; message: Record<string, unknown> }[] = [];
  return {
    published,
    client: {
      publish: vi.fn((channel: string, message: string) => {
        if (fail) return Promise.reject(new Error('redis down'));
        published.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
        return Promise.resolve();
      }),
      subscribe: vi.fn(),
    } as unknown as import('@evtivity/lib').PubSubClient,
  };
}

function row(over: Record<string, unknown> = {}): AiInsightRow {
  return {
    id: 'ain_1',
    kind: 'station_offline',
    subjectType: 'station',
    subjectId: 'sta_1',
    triggerKey: 't1',
    status: 'open',
    skipReason: null,
    siteId: 'sit_1',
    stationId: 'sta_1',
    sessionId: null,
    authorizeAttemptId: null,
    reservationId: null,
    parentInsightId: null,
    category: 'connectivity',
    confidence: 'high',
    fixes: [{ code: 'monitor' }, { code: 'not_a_fix' }],
    scope: {},
    evidenceRefs: [],
    generatedBy: 'model',
    primaryLanguage: 'en',
    provider: null,
    model: null,
    basisAt: new Date('2026-11-01T10:00:00Z'),
    basisFingerprint: 'fp1',
    requestedBy: null,
    createdAt: new Date('2026-11-01T09:00:00Z'),
    updatedAt: new Date('2026-11-01T09:00:00Z'),
    resolvedAt: null,
    dismissedAt: null,
    dismissedBy: null,
    feedbackUsed: false,
    ...over,
  };
}

beforeEach(() => {
  h.fake.reset();
  h.audits.length = 0;
  h.fingerprints.clear();
});

describe('createInsight', () => {
  it('inserts with defaults, cuts the trigger key to 200 characters and returns the id', async () => {
    h.fake.queue('insert:ai_insights', [{ id: 'ain_new' }]);
    const id = await svc.createInsight({
      kind: 'station_offline',
      subjectType: 'station',
      subjectId: 'sta_1',
      triggerKey: 'x'.repeat(250),
      siteId: 'sit_1',
      primaryLanguage: 'de',
    });
    expect(id).toBe('ain_new');
    const [call] = h.fake.find('insert', 'ai_insights');
    const values = call!.values as Record<string, unknown>;
    expect((values['triggerKey'] as string).length).toBe(200);
    expect(values).toMatchObject({
      status: 'analyzing',
      stationId: null,
      sessionId: null,
      requestedBy: null,
      parentInsightId: null,
    });
    expect(opArgs(call, 'onConflictDoNothing')).toBeDefined();
  });

  it('returns null when the trigger was seen before', async () => {
    const id = await svc.createInsight({
      kind: 'site_incident',
      subjectType: 'site',
      subjectId: 'sit_1',
      triggerKey: 'k',
      siteId: 'sit_1',
      primaryLanguage: 'en',
      status: 'superseded',
      parentInsightId: 'ain_p',
    });
    expect(id).toBeNull();
    expect(h.fake.find('insert', 'ai_insights')[0]!.values).toMatchObject({
      status: 'superseded',
      parentInsightId: 'ain_p',
    });
  });
});

describe('cooldowns', () => {
  const input = { subjectType: 'station', subjectId: 'sta_1', kind: 'station_offline' };

  it('claims when the upsert returns a row, and refuses when it returns none', async () => {
    h.fake.queue('client:INSERT INTO ai_insight_cooldowns', [{ subject_id: 'sta_1' }]);
    expect(await svc.claimInsightCooldown({ ...input, minutes: 30, insightId: 'ain_1' })).toBe(
      true,
    );
    expect(await svc.claimInsightCooldown({ ...input, minutes: 30, insightId: 'ain_2' })).toBe(
      false,
    );
    const [first] = h.fake.find('client', 'ai_insight_cooldowns');
    expect(first!.params).toEqual(['station', 'sta_1', 'station_offline', 30, 'ain_1']);
  });

  it('holds a cooldown with GREATEST so a longer one stays', async () => {
    await svc.holdInsightCooldown({ ...input, minutes: 60, insightId: 'ain_1' });
    const [call] = h.fake.find('client', 'ai_insight_cooldowns');
    expect(call!.text).toContain('GREATEST');
    expect(call!.params).toContain(60);
  });

  it('reads when the cooldown ends, or null without one', async () => {
    expect(await svc.insightCooldownUntil(input)).toBeNull();
    h.fake.queue('client:FROM ai_insight_cooldowns', [
      { next_allowed_at: '2026-11-12T10:00:00.000Z' },
    ]);
    const until = await svc.insightCooldownUntil(input);
    expect(until?.toISOString()).toBe('2026-11-12T10:00:00.000Z');
  });
});

describe('status moves', () => {
  it('skips with the rule fallback fields, or only the reason', async () => {
    h.fake.queue('update:ai_insights', [{ id: 'ain_1' }]);
    const ok = await svc.skipInsight('ain_1', 'budget_exceeded', {
      category: 'hardware',
      confidence: 'low',
      fixes: [{ code: 'monitor' }],
      scope: {},
    });
    expect(ok).toBe(true);
    expect(h.fake.calls[0]!.set).toMatchObject({
      status: 'skipped',
      skipReason: 'budget_exceeded',
      category: 'hardware',
      generatedBy: 'rule',
    });
    expect(await svc.skipInsight('ain_2', 'budget_exceeded')).toBe(false);
    expect(h.fake.calls[1]!.set).not.toHaveProperty('category');
    expect(await sqlParams(opArgs(h.fake.calls[1], 'where')?.[0])).toEqual(
      expect.arrayContaining(['ain_2', 'analyzing']),
    );
  });

  it('fails only an analyzing insight', async () => {
    h.fake.queue('update:ai_insights', [{ id: 'ain_1' }]);
    expect(await svc.failInsight('ain_1')).toBe(true);
    expect(await svc.failInsight('ain_1')).toBe(false);
    expect(h.fake.calls[0]!.set).toMatchObject({ status: 'failed' });
  });

  const result: InsightResult = {
    category: 'connectivity',
    confidence: 'high',
    fixes: [],
    evidenceRefs: ['e1'],
    scope: {},
    summary: 'The station lost its network.',
    language: 'en',
    generatedBy: 'model',
    provider: 'anthropic',
    model: 'm',
    basisAt: new Date('2026-11-01T00:00:00Z'),
    basisFingerprint: 'fp',
  };

  it('activates in one transaction and upserts the canonical text', async () => {
    h.fake.queue('update:ai_insights', [{ id: 'ain_1' }]);
    expect(await svc.activateInsight('ain_1', result)).toBe(true);
    const [upd] = h.fake.find('update', 'ai_insights');
    expect(upd!.inTx).toBe(true);
    expect(upd!.set).toMatchObject({ status: 'open', feedbackUsed: false, skipReason: null });
    const [text] = h.fake.find('insert', 'ai_insight_texts');
    expect(text!.values).toMatchObject({
      insightId: 'ain_1',
      language: 'en',
      summary: 'The station lost its network.',
      status: 'ready',
      source: 'generated',
    });
  });

  it('writes no text for a rule insight and nothing after a lost compare-and-set', async () => {
    h.fake.queue('update:ai_insights', [{ id: 'ain_1' }]);
    expect(
      await svc.activateInsight('ain_1', { ...result, summary: null, feedbackUsed: true }),
    ).toBe(true);
    expect(h.fake.calls[0]!.set).toMatchObject({ feedbackUsed: true });
    expect(await svc.activateInsight('ain_2', result)).toBe(false);
    expect(h.fake.find('insert', 'ai_insight_texts')).toHaveLength(0);
  });

  it('resolves, expires and attaches lists, and skips the query for an empty list', async () => {
    expect(await svc.resolveInsights([])).toEqual([]);
    expect(await svc.expireInsights([])).toEqual([]);
    expect(await svc.attachToIncident([], 'ain_p')).toEqual([]);
    expect(h.fake.calls).toHaveLength(0);

    h.fake.queue('update:ai_insights', [{ id: 'a' }, { id: 'b' }]);
    expect(await svc.resolveInsights(['a', 'b', 'c'])).toEqual(['a', 'b']);
    expect(h.fake.calls[0]!.set).toMatchObject({ status: 'resolved' });

    h.fake.queue('update:ai_insights', [{ id: 'a' }]);
    expect(await svc.expireInsights(['a'])).toEqual(['a']);
    expect(h.fake.calls[1]!.set).toMatchObject({ status: 'expired' });

    h.fake.queue('update:ai_insights', [{ id: 'm1' }]);
    expect(await svc.attachToIncident(['m1'], 'ain_p')).toEqual(['m1']);
    expect(h.fake.calls[2]!.set).toMatchObject({
      status: 'superseded',
      parentInsightId: 'ain_p',
    });
  });

  it('dismisses an open insight with an audit row, and nothing for a closed one', async () => {
    h.fake.queue('update:ai_insights', [{ id: 'ain_1', status: 'dismissed' }]);
    expect(await svc.dismissInsight('ain_1', actor)).toBe(true);
    expect(h.fake.calls[0]!.set).toMatchObject({ status: 'dismissed', dismissedBy: 'usr_1' });
    expect(h.audits).toEqual([
      expect.objectContaining({
        entityId: 'ain_1',
        action: 'dismissed',
        actorUserId: 'usr_1',
        actorApiKeyId: null,
        before: null,
        after: { status: 'dismissed' },
      }),
    ]);
    expect(await svc.dismissInsight('ain_2', { actor: 'system' } as never)).toBe(false);
    expect(h.audits).toHaveLength(1);
  });
});

describe('suppression dismissals', () => {
  const moved = [
    { id: 'a', siteId: 'sit_1', stationId: 'sta_1', sessionId: null, kind: 'station_offline' },
    { id: 'b', siteId: 'sit_1', stationId: 'sta_1', sessionId: 'ses_1', kind: 'session_failed' },
  ];

  it('dismisses a station insights with the cause, audits and publishes each', async () => {
    const ps = pubsub();
    h.fake.queue('update:ai_insights', moved);
    const ids = await svc.dismissStationInsights('sta_1', 'Noisy charger', actor, ps.client);
    expect(ids).toEqual(['a', 'b']);
    expect(h.audits.map((a) => a['after'])).toEqual([
      { status: 'dismissed', cause: 'station_ai_insights_suppressed' },
      { status: 'dismissed', cause: 'station_ai_insights_suppressed' },
    ]);
    expect(h.audits[0]!['notes']).toBe('Noisy charger');
    expect(ps.published.map((p) => [p.message['insightId'], p.message['status']])).toEqual([
      ['a', 'dismissed'],
      ['b', 'dismissed'],
    ]);
    expect(await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0])).toEqual(
      expect.arrayContaining(['sta_1', 'analyzing', 'open']),
    );
  });

  it('dismisses a site and its stations insights with the given cause', async () => {
    const ps = pubsub();
    h.fake.queue('update:ai_insights', [moved[0]]);
    const ids = await svc.dismissSiteInsights(
      'sit_9',
      'Out of scope',
      actor,
      ps.client,
      'ai_insights_scope',
    );
    expect(ids).toEqual(['a']);
    expect(h.audits[0]!['after']).toEqual({ status: 'dismissed', cause: 'ai_insights_scope' });
    const where = opArgs(h.fake.calls[0], 'where')?.[0];
    expect(await sqlString(where)).toContain('charging_stations cs');
    expect(await sqlString(where)).toContain('cs.is_operator');
  });

  it('keeps going when the publish fails (fail-open)', async () => {
    const ps = pubsub(true);
    h.fake.queue('update:ai_insights', moved);
    expect(await svc.dismissStationInsights('sta_1', 'r', actor, ps.client)).toEqual(['a', 'b']);
    expect(h.audits).toHaveLength(2);
  });
});

describe('siteInsightsSuppressed', () => {
  it('is true only when the row says suppressed', async () => {
    expect(await svc.siteInsightsSuppressed('sit_x')).toBe(false);
    h.fake.queue('client:FROM sites s', [{ suppressed: true }]);
    expect(await svc.siteInsightsSuppressed('sit_1')).toBe(true);
    h.fake.queue('client:FROM sites s', [{ suppressed: false }]);
    expect(await svc.siteInsightsSuppressed('sit_1')).toBe(false);
  });
});

describe('feedback reads', () => {
  it('summarizes counts with defaults for no row', async () => {
    expect(await svc.insightFeedbackSummary('ain_1', 'usr_1')).toEqual({
      helpfulCount: 0,
      wrongCount: 0,
      mine: null,
    });
    h.fake.queue('select:ai_insight_feedback', [{ helpfulCount: 3, wrongCount: 1, mine: true }]);
    expect(await svc.insightFeedbackSummary('ain_1', 'usr_1')).toEqual({
      helpfulCount: 3,
      wrongCount: 1,
      mine: true,
    });
  });

  it('rates by kind, drops unknown kinds and adds the scope and reservation filters', async () => {
    h.fake.queue('select:ai_insight_feedback', [
      { kind: 'station_offline', helpful: 2, wrong: 1 },
      { kind: 'retired_kind', helpful: 5, wrong: 0 },
    ]);
    const rates = await svc.insightFeedbackRates(['sit_1'], {
      days: 30,
      excludeReservations: true,
    });
    expect(rates).toEqual([{ kind: 'station_offline', helpful: 2, wrong: 1 }]);
    const params = await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0]);
    expect(params).toEqual(expect.arrayContaining([30, 'sit_1', 'reservation_no_show']));
  });

  it('rates with no site condition for an all-site user', async () => {
    await svc.insightFeedbackRates(null, { days: 7, excludeReservations: false });
    const params = await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0]);
    expect(params).not.toContain('reservation_no_show');
    expect(params).not.toContain('ai_insights.site_id');
  });

  it('pages the wrong votes with the total', async () => {
    const at = new Date('2026-11-02T00:00:00Z');
    h.fake.queue(
      (c) => c.kind === 'select' && opArgs(c, 'limit') != null,
      [{ userId: 'usr_2', reason: 'Not the cause', updatedAt: at }],
    );
    h.fake.queue('select:ai_insight_feedback', [{ total: 4 }]);
    const out = await svc.listInsightWrongVotes('ain_1', { limit: 1, offset: 2 });
    expect(out).toEqual({
      data: [{ userId: 'usr_2', reason: 'Not the cause', updatedAt: at }],
      total: 4,
    });
    const paged = h.fake.calls.find((c) => opArgs(c, 'offset') != null);
    expect(opArgs(paged, 'offset')).toEqual([2]);
  });

  it('answers a total of 0 when the count reads no row', async () => {
    const out = await svc.listInsightWrongVotes('ain_1', { limit: 10, offset: 0 });
    expect(out).toEqual({ data: [], total: 0 });
  });

  it('clears a vote with an audit row, and nothing when there was none', async () => {
    expect(await svc.clearInsightFeedback('ain_1', 'usr_1', actor)).toBe(false);
    h.fake.queue('delete:ai_insight_feedback', [{ helpful: false, reason: 'n' }]);
    expect(await svc.clearInsightFeedback('ain_1', 'usr_1', actor)).toBe(true);
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'feedback_cleared',
        before: { helpful: false, reasonGiven: true },
        after: { helpful: null },
      }),
    ]);
  });
});

describe('regenerateInsight', () => {
  it('refuses a missing, member or analyzing insight', async () => {
    expect(await svc.regenerateInsight('ain_x', actor)).toEqual({ status: 'not_allowed' });
    h.fake.queue('select:ai_insights', [row({ parentInsightId: 'ain_p' })]);
    expect(await svc.regenerateInsight('ain_1', actor)).toEqual({ status: 'not_allowed' });
    h.fake.queue('select:ai_insights', [row({ status: 'analyzing' })]);
    expect(await svc.regenerateInsight('ain_1', actor)).toEqual({ status: 'not_allowed' });
    expect(h.fake.find('insert')).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses while a generation of the same subject runs', async () => {
    h.fake.queue('select:ai_insights', [row()]);
    h.fake.queue('select:ai_insights', [{ id: 'ain_running' }]);
    expect(await svc.regenerateInsight('ain_1', actor)).toEqual({ status: 'busy' });
    expect(h.fake.find('insert')).toHaveLength(0);
  });

  it('creates the new insight, supersedes the old and audits whether a note was used', async () => {
    h.fake.queue('select:ai_insights', [row()]);
    h.fake.queue('select:ai_insights', []);
    h.fake.queue('select:ai_insight_feedback', [{ reason: 'Wrong station' }]);
    h.fake.queue('insert:ai_insights', [{ id: 'ain_new' }]);
    const out = await svc.regenerateInsight('ain_1', actor);
    expect(out).toEqual({ status: 'created', insightId: 'ain_new', feedbackUsed: true });
    const [ins] = h.fake.find('insert', 'ai_insights');
    expect(ins!.values).toMatchObject({ status: 'analyzing', requestedBy: 'usr_1' });
    expect((ins!.values as { triggerKey: string }).triggerKey).toMatch(/^regenerate:ain_1:\d+$/);
    const updates = h.fake.find('update', 'ai_insights');
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toMatchObject({ status: 'superseded' });
    expect(h.audits).toEqual([
      expect.objectContaining({
        entityId: 'ain_1',
        action: 'regenerated',
        after: { newInsightId: 'ain_new', feedbackUsed: true },
      }),
    ]);
  });

  it('moves the members of a site incident to the new incident', async () => {
    h.fake.queue('select:ai_insights', [row({ kind: 'site_incident', status: 'resolved' })]);
    h.fake.queue('select:ai_insights', []);
    h.fake.queue('insert:ai_insights', [{ id: 'ain_new' }]);
    const out = await svc.regenerateInsight('ain_1', actor);
    expect(out).toMatchObject({ status: 'created', feedbackUsed: false });
    const updates = h.fake.find('update', 'ai_insights');
    expect(updates.map((u) => u.set)).toEqual([
      expect.objectContaining({ parentInsightId: 'ain_new' }),
      expect.objectContaining({ status: 'superseded' }),
    ]);
  });

  it('throws when the insert returns no row, and audits nothing', async () => {
    h.fake.queue('select:ai_insights', [row()]);
    await expect(svc.regenerateInsight('ain_1', actor)).rejects.toThrow(
      'Insight regeneration insert returned no row',
    );
    expect(h.audits).toHaveLength(0);
  });
});

describe('translations', () => {
  it('returns the try stamp when a try started, else null', async () => {
    expect(await svc.requestInsightTranslation('ain_1', 'de')).toBeNull();
    const at = new Date('2026-11-12T08:00:00Z');
    h.fake.queue('insert:ai_insight_texts', [{ updatedAt: at }]);
    expect(await svc.requestInsightTranslation('ain_1', 'de')).toBe(at.getTime());
    expect(h.fake.calls[1]!.values).toMatchObject({ status: 'pending', source: 'translated' });
  });

  it('stores a ready text or unavailable, only on a pending row', async () => {
    h.fake.queue('update:ai_insight_texts', [{ insightId: 'ain_1' }]);
    expect(await svc.storeInsightTranslation('ain_1', 'de', 'Text')).toBe(true);
    expect(h.fake.calls[0]!.set).toMatchObject({ summary: 'Text', status: 'ready' });
    expect(await svc.storeInsightTranslation('ain_1', 'de', null)).toBe(false);
    expect(h.fake.calls[1]!.set).toMatchObject({ summary: null, status: 'unavailable' });
  });
});

describe('scan watermarks', () => {
  it('reads null without a row and converts the id', async () => {
    expect(await svc.readScanWatermark('authorize')).toBeNull();
    h.fake.queue('client:ai_insight_scan_state', [
      { last_id: '42', last_at: '2026-11-12 08:00:00.123456+00', last_key: 'k' },
    ]);
    expect(await svc.readScanWatermark('authorize')).toEqual({
      lastId: 42,
      lastAt: '2026-11-12 08:00:00.123456+00',
      lastKey: 'k',
    });
    h.fake.queue('client:ai_insight_scan_state', [
      { last_id: null, last_at: null, last_key: null },
    ]);
    expect(await svc.readScanWatermark('x')).toEqual({ lastId: null, lastAt: null, lastKey: null });
  });

  it('writes forward only', async () => {
    await svc.writeScanWatermark('authorize', { lastId: 7, lastAt: null, lastKey: null });
    const [call] = h.fake.find('client', 'ai_insight_scan_state');
    expect(call!.text).toContain('GREATEST');
    expect(call!.params).toEqual(['authorize', 7, null, null]);
  });
});

describe('publishing', () => {
  it('publishes an insight update and swallows a publish error', async () => {
    const ps = pubsub();
    await svc.publishInsightUpdated(ps.client, row());
    expect(ps.published[0]).toEqual({
      channel: 'csms_events',
      message: {
        eventType: svc.AI_INSIGHT_UPDATED_EVENT,
        insightId: 'ain_1',
        siteId: 'sit_1',
        stationId: 'sta_1',
        sessionId: null,
        kind: 'station_offline',
        status: 'open',
      },
    });
    await expect(svc.publishInsightUpdated(pubsub(true).client, row())).resolves.toBeUndefined();
  });

  it('publishes a worker request and reports a failure', async () => {
    const ps = pubsub();
    expect(await svc.publishInsightRequest(ps.client, { kind: 'generate', insightId: 'a' })).toBe(
      true,
    );
    expect(ps.published[0]!.channel).toBe(svc.AI_INSIGHT_REQUESTS_CHANNEL);
    expect(
      await svc.publishInsightRequest(pubsub(true).client, {
        kind: 'translate',
        insightId: 'a',
        language: 'de',
        attempt: 1,
      }),
    ).toBe(false);
  });
});

describe('reads', () => {
  it('reads one row or null', async () => {
    expect(await svc.getInsightRow('ain_x')).toBeNull();
    h.fake.queue('select:ai_insights', [row()]);
    expect((await svc.getInsightRow('ain_1'))?.id).toBe('ain_1');
  });

  it('maps covered attempts per insight and skips the query for empty lists', async () => {
    expect((await svc.insightCoveredAttempts([], [1])).size).toBe(0);
    expect((await svc.insightCoveredAttempts(['a'], [])).size).toBe(0);
    expect(h.fake.calls).toHaveLength(0);
    h.fake.queue('client:authorize_attempts', [
      { insight_id: 'a', attempt_id: 1 },
      { insight_id: 'a', attempt_id: 2 },
      { insight_id: 'b', attempt_id: 3 },
    ]);
    const out = await svc.insightCoveredAttempts(['a', 'b'], [1, 2, 3]);
    expect(Object.fromEntries(out)).toEqual({ a: [1, 2], b: [3] });
  });

  it('builds the site condition for all, none and some sites', async () => {
    expect(svc.insightSiteCondition(null)).toBeUndefined();
    expect(await sqlString(svc.insightSiteCondition([]))).toBe('false');
    expect(await sqlParams(svc.insightSiteCondition(['s1', 's2']))).toEqual(
      expect.arrayContaining(['s1', 's2']),
    );
  });

  it('lists with every filter and returns the total', async () => {
    h.fake.queue((c) => c.kind === 'select' && opArgs(c, 'limit') != null, [row()]);
    h.fake.queue('select:ai_insights', [{ n: 9 }]);
    const out = await svc.listInsightRows(
      {
        stationId: 'sta_1',
        sessionId: 'ses_1',
        siteId: 'sit_1',
        statuses: ['open'],
        category: 'hardware',
        feedback: 'wrong',
        excludeReservations: true,
        authorizeAttemptIds: [11, 12],
        supportCase: { stationId: 'sta_2', sessionIds: ['ses_2'] },
      },
      ['sit_1'],
      { limit: 20, offset: 0 },
    );
    expect(out.total).toBe(9);
    expect(out.rows).toHaveLength(1);
    const where = opArgs(h.fake.calls[0], 'where')?.[0];
    const text = await sqlString(where);
    expect(text).toContain('ai_insight_feedback f');
    expect(text).toContain('authorize_attempts f, authorize_attempts a');
    const params = await sqlParams(where);
    expect(params).toEqual(
      expect.arrayContaining([
        'sta_1',
        'ses_1',
        'hardware',
        false,
        11,
        12,
        'authorization_refused',
        'sta_2',
        'ses_2',
        'reservation_no_show',
      ]),
    );
  });

  it('lists nothing for empty attempt and support case filters', async () => {
    const out = await svc.listInsightRows(
      {
        authorizeAttemptIds: [],
        supportCase: { stationId: null, sessionIds: [] },
        reservationId: 'res_1',
        kind: 'reservation_no_show',
        stationId: 'sta_1',
      },
      [],
      { limit: 5, offset: 0 },
    );
    expect(out).toEqual({ rows: [], total: 0 });
    const where = opArgs(h.fake.calls[0], 'where')?.[0];
    expect((await sqlString(where)).match(/false/g)?.length).toBeGreaterThanOrEqual(3);
    // A station filter with a reservation or kind keeps reservation insights.
    expect(await sqlParams(where)).not.toContain('reservation_rejected');
  });

  it('leaves reservation insights out of a plain station list', async () => {
    await svc.listInsightRows({ stationId: 'sta_1' }, null, { limit: 5, offset: 0 });
    expect(await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0])).toContain(
      'reservation_rejected',
    );
  });

  it('picks the requested and the primary text per insight', async () => {
    expect((await svc.insightTexts([], 'de')).size).toBe(0);
    h.fake.queue('select:ai_insight_texts', [
      { insightId: 'a', language: 'de', summary: 'Hallo', status: 'ready' },
      { insightId: 'a', language: 'en', summary: 'Hello', status: 'ready' },
      { insightId: 'b', language: 'en', summary: 'Hi', status: 'ready' },
    ]);
    const out = await svc.insightTexts(
      [
        { id: 'a', primaryLanguage: 'en' },
        { id: 'b', primaryLanguage: 'en' },
        { id: 'c', primaryLanguage: 'fr' },
      ],
      'de',
    );
    expect(out.get('a')).toEqual({
      requested: { insightId: 'a', language: 'de', summary: 'Hallo', status: 'ready' },
      primary: { insightId: 'a', language: 'en', summary: 'Hello', status: 'ready' },
    });
    expect(out.get('b')).toEqual({
      primary: { insightId: 'b', language: 'en', summary: 'Hi', status: 'ready' },
    });
    expect(out.get('c')).toEqual({});
  });
});

describe('toInsightDto and originalSummary', () => {
  it('uses a ready requested text and drops fixes the schema does not know', () => {
    const dto = svc.toInsightDto(
      row(),
      { requested: { insightId: 'ain_1', language: 'de', summary: 'Hallo', status: 'ready' } },
      { language: 'de', stale: true },
    );
    expect(dto).toMatchObject({
      summary: 'Hallo',
      textStatus: 'ready',
      language: 'de',
      stale: true,
      fixes: [{ code: 'monitor' }],
      basisAt: '2026-11-01T10:00:00.000Z',
      action: null,
    });
  });

  it('reports pending for a pending text or an analyzing insight, else unavailable', () => {
    const pending = svc.toInsightDto(
      row(),
      { requested: { insightId: 'ain_1', language: 'de', summary: null, status: 'pending' } },
      { language: 'de', stale: false },
    );
    expect(pending.textStatus).toBe('pending');
    expect(pending.language).toBe('en');
    const analyzing = svc.toInsightDto(row({ status: 'analyzing' }), undefined, {
      language: 'en',
      stale: false,
    });
    expect(analyzing.textStatus).toBe('pending');
    const other = svc.toInsightDto(
      row({ kind: 'gone_kind', fixes: 'not an array', scope: 'bad', basisAt: null }),
      undefined,
      { language: 'en', stale: false },
    );
    expect(other).toMatchObject({
      kind: 'station_alert',
      textStatus: 'unavailable',
      fixes: [],
      scope: {},
      basisAt: null,
      summary: null,
    });
  });

  it('offers the primary text only when it is ready', () => {
    expect(svc.originalSummary(undefined)).toBeNull();
    expect(
      svc.originalSummary({
        primary: { insightId: 'a', language: 'en', summary: 'S', status: 'ready' },
      }),
    ).toBe('S');
    expect(
      svc.originalSummary({
        primary: { insightId: 'a', language: 'en', summary: null, status: 'pending' },
      }),
    ).toBeNull();
  });
});

describe('staleFlags', () => {
  it('flags only live insights whose fingerprint changed', async () => {
    h.fingerprints.set('a', 'fp_new');
    h.fingerprints.set('b', 'fp1');
    const flags = await svc.staleFlags([
      row({ id: 'a' }),
      row({ id: 'b' }),
      row({ id: 'c', status: 'resolved' }),
      row({ id: 'd', basisFingerprint: null }),
    ]);
    expect(Object.fromEntries(flags)).toEqual({ a: true, b: false, c: false, d: false });
  });
});

describe('worker insights', () => {
  it('stores a tariff finding as an active rule insight and publishes it', async () => {
    const ps = pubsub();
    h.fake.queue('insert:ai_insights', [{ id: 'ain_t' }]);
    h.fake.queue('update:ai_insights', [{ id: 'ain_t' }]);
    const id = await svc.storeWorkerInsight(
      {
        kind: 'tariff_anomaly',
        siteId: null,
        triggerKey: 'tariff:2026-11',
        narrative: null,
        primaryLanguage: 'en',
      },
      ps.client,
    );
    expect(id).toBe('ain_t');
    expect(h.fake.find('insert', 'ai_insights')[0]!.values).toMatchObject({
      subjectType: 'company',
      subjectId: 'company',
    });
    expect(h.fake.find('update', 'ai_insights')[0]!.set).toMatchObject({
      category: 'tariff',
      fixes: [{ code: 'review_tariff_assignment' }],
      generatedBy: 'rule',
    });
    expect(h.fake.find('insert', 'ai_insight_texts')).toHaveLength(0);
    expect(ps.published[0]!.message).toMatchObject({ insightId: 'ain_t', status: 'open' });
  });

  it('stores a site summary narrative and returns null for a repeated trigger', async () => {
    const ps = pubsub();
    h.fake.queue('insert:ai_insights', [{ id: 'ain_s' }]);
    const id = await svc.storeWorkerInsight(
      {
        kind: 'site_summary',
        siteId: 'sit_1',
        triggerKey: 'k',
        narrative: { text: 'Busy week', language: 'de', provider: 'p', model: 'm' },
        primaryLanguage: 'en',
      },
      ps.client,
    );
    // The activation lost its compare-and-set: no publish.
    expect(id).toBe('ain_s');
    expect(ps.published).toHaveLength(0);
    expect(
      await svc.storeWorkerInsight(
        {
          kind: 'site_summary',
          siteId: 'sit_1',
          triggerKey: 'k',
          narrative: null,
          primaryLanguage: 'en',
        },
        ps.client,
      ),
    ).toBeNull();
  });

  it('checks whether a trigger exists', async () => {
    expect(
      await svc.insightTriggerExists({
        kind: 'stuck_session',
        subjectType: 'session',
        subjectId: 'ses_1',
        triggerKey: 'k',
      }),
    ).toBe(false);
    h.fake.queue('select:ai_insights', [{ id: 'x' }]);
    expect(
      await svc.insightTriggerExists({
        kind: 'stuck_session',
        subjectType: 'session',
        subjectId: 'ses_1',
        triggerKey: 'k',
      }),
    ).toBe(true);
  });

  it('derives the worker root cause from the kind or the worker', () => {
    expect(svc.workerActionRootCause({ kind: 'station_long_faulted' })).toEqual({
      category: 'hardware',
      confidence: 'medium',
    });
    expect(
      svc.workerActionRootCause({
        kind: 'stuck_session',
        rootCause: { category: 'connectivity', confidence: 'high' },
      }),
    ).toEqual({ category: 'connectivity', confidence: 'high' });
  });

  it('stores a worker action insight on its session with the worker fixes', async () => {
    const ps = pubsub();
    h.fake.queue('insert:ai_insights', [{ id: 'ain_w' }]);
    h.fake.queue('update:ai_insights', [{ id: 'ain_w' }]);
    const id = await svc.storeWorkerActionInsight(
      {
        kind: 'stuck_session',
        siteId: 'sit_1',
        stationId: 'sta_1',
        sessionId: 'ses_1',
        triggerKey: 'stuck:ses_1',
        narrative: { text: 'Stuck', language: 'en', provider: 'p', model: 'm' },
        primaryLanguage: 'en',
        fixes: ['monitor'],
        scope: { stationOffline: { since: '2026-11-12T00:00:00Z' } },
      },
      ps.client,
    );
    expect(id).toBe('ain_w');
    expect(h.fake.find('insert', 'ai_insights')[0]!.values).toMatchObject({
      subjectType: 'session',
      subjectId: 'ses_1',
    });
    expect(h.fake.find('update', 'ai_insights')[0]!.set).toMatchObject({
      fixes: [{ code: 'monitor' }],
      generatedBy: 'model',
      scope: { stationOffline: { since: '2026-11-12T00:00:00Z' } },
    });
    expect(h.fake.find('insert', 'ai_insight_texts')).toHaveLength(1);
    expect(ps.published[0]!.message).toMatchObject({ sessionId: 'ses_1', status: 'open' });
  });

  it('stores a station action insight with the kind fixes, or null for a repeat', async () => {
    const ps = pubsub();
    h.fake.queue('insert:ai_insights', [{ id: 'ain_f' }]);
    const id = await svc.storeWorkerActionInsight(
      {
        kind: 'station_long_faulted',
        siteId: null,
        stationId: 'sta_1',
        sessionId: null,
        triggerKey: 'f',
        narrative: null,
        primaryLanguage: 'en',
      },
      ps.client,
    );
    expect(id).toBe('ain_f');
    expect(h.fake.find('insert', 'ai_insights')[0]!.values).toMatchObject({
      subjectType: 'station',
      subjectId: 'sta_1',
    });
    expect(ps.published).toHaveLength(0);
    expect(
      await svc.storeWorkerActionInsight(
        {
          kind: 'station_long_faulted',
          siteId: null,
          stationId: 'sta_1',
          sessionId: null,
          triggerKey: 'f',
          narrative: null,
          primaryLanguage: 'en',
        },
        ps.client,
      ),
    ).toBeNull();
  });
});

describe('action insights', () => {
  it('marks an open insight pending in the given transaction, or null', async () => {
    h.fake.queue('update:ai_insights', [row({ status: 'pending' })]);
    const tx = h.fake.db as never;
    expect((await svc.markInsightActionPending(tx, 'ain_1'))?.status).toBe('pending');
    expect(await svc.markInsightActionPending(tx, 'ain_1')).toBeNull();
  });

  it('closes by the action status: resolved sets resolvedAt, rejected is audited', async () => {
    const ps = pubsub();
    h.fake.queue('update:ai_insights', [row({ status: 'resolved' })]);
    expect(await svc.closeActionInsight('ain_1', 'stale', actor, ps.client)).toBe(true);
    expect(h.fake.calls[0]!.set).toHaveProperty('resolvedAt');
    expect(h.fake.calls[0]!.set).toMatchObject({ status: 'resolved' });
    expect(h.audits).toHaveLength(0);

    h.fake.queue('update:ai_insights', [row({ status: 'rejected' })]);
    expect(await svc.closeActionInsight('ain_1', 'rejected', actor, ps.client)).toBe(true);
    expect(h.audits[0]).toMatchObject({ action: 'rejected', after: { status: 'rejected' } });
    expect(ps.published).toHaveLength(2);
  });

  it('closes a rejection by dismissal as dismissed, audited as a dismissal', async () => {
    const ps = pubsub();
    h.fake.queue('update:ai_insights', [row({ status: 'dismissed' })]);
    expect(
      await svc.closeActionInsight('ain_1', 'rejected', actor, ps.client, { dismiss: true }),
    ).toBe(true);
    expect(h.fake.calls[0]!.set).toMatchObject({ status: 'dismissed', dismissedBy: 'usr_1' });
    expect(h.audits[0]).toMatchObject({ action: 'dismissed' });
  });

  it('ignores dismiss for a non-rejection and changes nothing when no longer pending', async () => {
    const ps = pubsub();
    expect(
      await svc.closeActionInsight('ain_1', 'executed', actor, ps.client, { dismiss: true }),
    ).toBe(false);
    expect(h.fake.calls[0]!.set).toMatchObject({ status: 'done' });
    expect(h.fake.calls[0]!.set).not.toHaveProperty('dismissedAt');
    expect(ps.published).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});
