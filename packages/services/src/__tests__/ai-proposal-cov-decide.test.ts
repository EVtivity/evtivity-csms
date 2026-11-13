// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Insight actions after creation (`ai-proposal.service.ts`): reads, the
// claim, finish and reject moves (compare-and-set, P5), the expiry sweep,
// the preconditions and the DTO, with their audit rows and insight closes.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/fake-db.js';
import { opArgs, sqlParams, sqlString } from './helpers/fake-db.js';

const h = vi.hoisted(() => ({
  fake: undefined as unknown as FakeDb,
  audits: [] as Record<string, unknown>[],
  published: [] as { channel: string; message: Record<string, unknown> }[],
  publishFails: false,
  closed: [] as unknown[][],
  closeFails: false,
  cooldowns: [] as Record<string, unknown>[],
  cooldownFails: false,
  settingsFail: false,
}));

vi.mock('@evtivity/database', async () => {
  const { createFakeDb, fakeDatabaseModule } = await import('./helpers/fake-db.js');
  h.fake = createFakeDb();
  return fakeDatabaseModule(h.fake, {
    operatorStationSql: (alias: string) => `${alias}.is_operator`,
    getAiInsightSettings: () =>
      h.settingsFail
        ? Promise.reject(new Error('settings down'))
        : Promise.resolve({ cooldownMinutes: 45 }),
    writeAudit: (_cfg: unknown, args: Record<string, unknown>) => {
      h.audits.push(args);
      return Promise.resolve();
    },
  });
});

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: (channel: string, message: string) => {
      if (h.publishFails) return Promise.reject(new Error('redis down'));
      h.published.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve(),
  }),
}));

vi.mock('../ai-insight.service.js', () => ({
  AI_INSIGHT_UPDATED_EVENT: 'ai.insight.updated',
  closeActionInsight: (...args: unknown[]) => {
    h.closed.push(args);
    return h.closeFails ? Promise.reject(new Error('close failed')) : Promise.resolve(true);
  },
  holdInsightCooldown: (input: Record<string, unknown>) => {
    h.cooldowns.push(input);
    return h.cooldownFails ? Promise.reject(new Error('cooldown failed')) : Promise.resolve();
  },
  markInsightActionPending: () => Promise.resolve(null),
  publishInsightUpdated: () => Promise.resolve(),
}));

const svc = await import('../ai-proposal.service.js');

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
const actor = { actor: 'operator' as const, actorUserId: 'usr_1' };

function proposal(
  over: Partial<import('../ai-proposal.service.js').AiProposalRow> = {},
): import('../ai-proposal.service.js').AiProposalRow {
  return {
    id: 'aip_1',
    insightId: 'ain_1',
    job: 'stuck_sessions',
    siteId: 'sit_1',
    stationId: 'sta_1',
    sessionId: 'ses_1',
    operationId: 'stopSession',
    method: 'POST',
    path: '/v1/sessions/ses_1/stop',
    args: { id: 'ses_1' },
    argsHash: 'h',
    summary: { code: 'stop' },
    precondition: { kind: 'session_active', params: { sessionId: 'ses_1' } },
    status: 'pending',
    dedupKey: 'k',
    expiresAt: new Date('2026-11-13T00:00:00Z'),
    decidedBy: null,
    decidedAt: null,
    executedAt: null,
    result: null,
    createdAt: new Date('2026-11-12T00:00:00Z'),
    updatedAt: new Date('2026-11-12T00:00:00Z'),
    ...over,
  } as unknown as import('../ai-proposal.service.js').AiProposalRow;
}

beforeEach(() => {
  h.fake.reset();
  h.audits.length = 0;
  h.published.length = 0;
  h.closed.length = 0;
  h.cooldowns.length = 0;
  h.publishFails = false;
  h.closeFails = false;
  h.cooldownFails = false;
  h.settingsFail = false;
  log.warn.mockClear();
});

describe('reads', () => {
  it('builds the site condition for all, none and some sites', async () => {
    expect(await sqlString(svc.aiProposalSiteCondition(null))).toBe('true');
    expect(await sqlString(svc.aiProposalSiteCondition([]))).toBe('false');
    expect(await sqlParams(svc.aiProposalSiteCondition(['s1']))).toContain('s1');
  });

  it('maps actions by insight and skips the query for no insights', async () => {
    expect((await svc.insightActionRows([])).size).toBe(0);
    expect(h.fake.calls).toHaveLength(0);
    h.fake.queue('select:ai_proposals', [
      proposal(),
      proposal({ id: 'aip_2', insightId: 'ain_2' }),
    ]);
    const map = await svc.insightActionRows(['ain_1', 'ain_2']);
    expect(map.get('ain_2')?.id).toBe('aip_2');
  });

  it('tells whether a pending action holds the dedup key', async () => {
    expect(await svc.hasPendingAiProposal('k')).toBe(false);
    h.fake.queue('select:ai_proposals', [{ id: 'aip_1' }]);
    expect(await svc.hasPendingAiProposal('k')).toBe(true);
  });

  it('reads the action of an insight or null', async () => {
    expect(await svc.getInsightActionRow('ain_x')).toBeNull();
    h.fake.queue('select:ai_proposals', [proposal()]);
    expect((await svc.getInsightActionRow('ain_1'))?.id).toBe('aip_1');
  });
});

describe('claimAiProposal', () => {
  it('claims a pending row and audits the confirm', async () => {
    h.fake.queue('update:ai_proposals', [proposal({ decidedBy: 'usr_1' })]);
    const out = await svc.claimAiProposal('aip_1', actor, log);
    expect(out.kind).toBe('claimed');
    expect(h.fake.calls[0]!.set).toMatchObject({ decidedBy: 'usr_1' });
    expect(h.audits[0]).toMatchObject({
      action: 'confirmed',
      before: { status: 'pending' },
      after: { status: 'pending', decidedBy: 'usr_1', operationId: 'stopSession' },
      viaAi: null,
    });
  });

  it('answers not_found for an unknown id', async () => {
    expect(await svc.claimAiProposal('aip_x', actor, log)).toEqual({ kind: 'not_found' });
  });

  it('expires an unclaimed row past its expiry and closes its insight', async () => {
    h.fake.queue('select:ai_proposals', [proposal()]);
    // The claim update (first) answers nothing; the expiry update answers the row.
    h.fake.queue(
      (c) => c.kind === 'update' && (c.set as { status?: string }).status === 'expired',
      [proposal({ status: 'expired' })],
    );
    const out = await svc.claimAiProposal('aip_1', actor, log);
    expect(out.kind).toBe('expired');
    expect(h.audits[0]).toMatchObject({
      action: 'expired',
      actor: 'system',
      actorLabel: 'ai-proposal-sweep',
    });
    expect(h.closed[0]!.slice(0, 2)).toEqual(['ain_1', 'expired']);
    expect(h.published[0]!.message).toMatchObject({
      insightId: 'ain_1',
      eventType: 'ai.insight.updated',
    });
  });

  it('answers decided for a row another confirm holds, or expired for an expired one', async () => {
    h.fake.queue('select:ai_proposals', [proposal({ decidedAt: new Date() })]);
    h.fake.queue('select:ai_proposals', [proposal({ decidedAt: new Date() })]);
    expect((await svc.claimAiProposal('aip_1', actor, log)).kind).toBe('decided');

    h.fake.queue('select:ai_proposals', [proposal({ status: 'expired' })]);
    h.fake.queue('select:ai_proposals', [proposal({ status: 'expired' })]);
    expect((await svc.claimAiProposal('aip_1', actor, log)).kind).toBe('expired');
  });

  it('answers not_found when the row disappeared between the reads', async () => {
    // Pending and unclaimed, but the expiry did not apply (not yet expired) and the re-read finds none.
    h.fake.queue('select:ai_proposals', [proposal()]);
    expect(await svc.claimAiProposal('aip_1', actor, log)).toEqual({ kind: 'not_found' });
  });
});

describe('finishAiProposal', () => {
  it('stores an executed result, audits it and closes the insight', async () => {
    h.fake.queue('update:ai_proposals', [proposal({ status: 'executed', decidedBy: 'usr_1' })]);
    const row = await svc.finishAiProposal(
      'aip_1',
      actor,
      { status: 'executed', result: { httpStatus: 200, body: { ok: true } } },
      log,
    );
    expect(row?.status).toBe('executed');
    const set = h.fake.calls[0]!.set as Record<string, unknown>;
    expect(set).toMatchObject({
      status: 'executed',
      result: { httpStatus: 200, body: { ok: true } },
    });
    expect(set).toHaveProperty('executedAt');
    expect(await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0])).toContain('usr_1');
    expect(h.audits[0]).toMatchObject({
      action: 'executed',
      before: { status: 'pending', decidedBy: 'usr_1' },
    });
    expect(h.closed[0]!.slice(0, 3)).toEqual([
      'ain_1',
      'executed',
      { actor: 'operator', actorUserId: 'usr_1' },
    ]);
  });

  it('stores a stale end without a result', async () => {
    h.fake.queue('update:ai_proposals', [proposal({ status: 'stale' })]);
    await svc.finishAiProposal('aip_1', actor, { status: 'stale' }, log);
    const set = h.fake.calls[0]!.set as Record<string, unknown>;
    expect(set['result']).toBeNull();
    expect(set).not.toHaveProperty('executedAt');
  });

  it('returns null when the row was not the caller claim', async () => {
    expect(await svc.finishAiProposal('aip_1', actor, { status: 'expired' }, log)).toBeNull();
    expect(h.audits).toHaveLength(0);
    expect(h.closed).toHaveLength(0);
  });

  it('keeps going when the publish and the insight close fail (fail-open)', async () => {
    h.publishFails = true;
    h.closeFails = true;
    h.fake.queue('update:ai_proposals', [proposal({ status: 'failed' })]);
    const row = await svc.finishAiProposal(
      'aip_1',
      actor,
      { status: 'failed', result: { httpStatus: 500 } },
      log,
    );
    expect(row?.status).toBe('failed');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe('rejectAiProposal', () => {
  it('rejects, audits and dismisses the insight on request', async () => {
    h.fake.queue('update:ai_proposals', [proposal({ status: 'rejected', decidedBy: 'usr_1' })]);
    const out = await svc.rejectAiProposal('aip_1', actor, log, { dismissInsight: true });
    expect(out.kind).toBe('rejected');
    expect(h.audits[0]).toMatchObject({ action: 'rejected', after: { status: 'rejected' } });
    expect(h.closed[0]![4]).toEqual({ dismiss: true });
  });

  it('expires a rejection that came too late', async () => {
    h.fake.queue(
      (c) => c.kind === 'update' && (c.set as { status?: string }).status === 'expired',
      [proposal({ status: 'expired' })],
    );
    expect((await svc.rejectAiProposal('aip_1', actor, log)).kind).toBe('expired');
  });

  it('answers decided, expired or not_found from the current row', async () => {
    h.fake.queue('select:ai_proposals', [proposal({ decidedAt: new Date() })]);
    expect((await svc.rejectAiProposal('aip_1', actor, log)).kind).toBe('decided');
    h.fake.queue('select:ai_proposals', [proposal({ status: 'expired' })]);
    expect((await svc.rejectAiProposal('aip_1', actor, log)).kind).toBe('expired');
    expect(await svc.rejectAiProposal('aip_1', actor, log)).toEqual({ kind: 'not_found' });
  });
});

describe('suppression expiry', () => {
  it('expires a station pending actions with the reason', async () => {
    h.fake.queue('update:ai_proposals', [
      proposal({ status: 'expired' }),
      proposal({ id: 'aip_2', status: 'expired' }),
    ]);
    expect(await svc.expireStationAiProposals('sta_1', 'Suppressed', actor, log)).toBe(2);
    expect(h.audits.map((a) => a['notes'])).toEqual(['Suppressed', 'Suppressed']);
    expect(h.closed).toHaveLength(2);
    expect(await sqlParams(opArgs(h.fake.calls[0], 'where')?.[0])).toContain('sta_1');
  });

  it('expires a site and its stations actions', async () => {
    expect(await svc.expireSiteAiProposals('sit_1', 'Suppressed', actor, log)).toBe(0);
    const text = await sqlString(opArgs(h.fake.calls[0], 'where')?.[0]);
    expect(text).toContain('charging_stations cs');
    expect(text).toContain('cs.is_operator');
  });
});

describe('sweepAiProposals', () => {
  it('expires, stales and fails interrupted claims, with the stuck-session cooldown', async () => {
    const byStatus = (s: string) => (c: { kind: string; set?: unknown }) =>
      c.kind === 'update' && (c.set as { status?: string }).status === s;
    h.fake.queue(byStatus('expired'), [
      proposal({ status: 'expired' }),
      proposal({ id: 'aip_2', job: 'network_summary', sessionId: null, status: 'expired' }),
    ]);
    h.fake.queue(byStatus('stale'), [proposal({ id: 'aip_3', status: 'stale' })]);
    h.fake.queue(byStatus('failed'), [
      proposal({ id: 'aip_4', status: 'failed', decidedBy: 'usr_2' }),
    ]);
    const out = await svc.sweepAiProposals(log);
    expect(out).toEqual({ expired: 2, interrupted: 1, stale: 1 });
    expect(h.cooldowns).toEqual([
      {
        subjectType: 'session',
        subjectId: 'ses_1',
        kind: 'stuck_session',
        minutes: 45,
        insightId: 'ain_1',
      },
    ]);
    expect(h.audits.map((a) => [a['entityId'], a['action'], a['notes']])).toEqual([
      ['aip_1', 'expired', null],
      ['aip_2', 'expired', null],
      ['aip_3', 'stale', 'The session is no longer active'],
      ['aip_4', 'failed', 'The confirm did not finish'],
    ]);
    const failedSet = h.fake.calls.find(byStatus('failed'))!.set as Record<string, unknown>;
    expect(failedSet['result']).toEqual({ httpStatus: 0, body: { error: 'interrupted' } });
  });

  it('uses the default cooldown when settings fail and survives a failed hold', async () => {
    h.settingsFail = true;
    h.cooldownFails = true;
    h.fake.queue(
      (c) => c.kind === 'update' && (c.set as { status?: string }).status === 'expired',
      [proposal({ status: 'expired' })],
    );
    const out = await svc.sweepAiProposals(log);
    expect(out.expired).toBe(1);
    expect(typeof h.cooldowns[0]!['minutes']).toBe('number');
    expect(h.cooldowns[0]!['minutes']).not.toBe(45);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('reads no settings when nothing expired', async () => {
    h.settingsFail = true;
    expect(await svc.sweepAiProposals(log)).toEqual({ expired: 0, interrupted: 0, stale: 0 });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('aiProposalPreconditionHolds', () => {
  it('session_active: needs the session id, an active session and the same transaction', async () => {
    expect(
      await svc.aiProposalPreconditionHolds({ kind: 'session_active', params: { sessionId: '' } }),
    ).toBe(false);
    expect(
      await svc.aiProposalPreconditionHolds({ kind: 'session_active', params: { sessionId: 's' } }),
    ).toBe(false);
    h.fake.queue('select:charging_sessions', [
      { status: 'active', transactionId: 'tx1', stationOnline: true },
    ]);
    expect(
      await svc.aiProposalPreconditionHolds({
        kind: 'session_active',
        params: { sessionId: 's', transactionId: 'tx1', stationOnline: true },
      }),
    ).toBe(true);
    h.fake.queue('select:charging_sessions', [
      { status: 'active', transactionId: 'tx2', stationOnline: true },
    ]);
    expect(
      await svc.aiProposalPreconditionHolds({
        kind: 'session_active',
        params: { sessionId: 's', transactionId: 'tx1' },
      }),
    ).toBe(false);
    h.fake.queue('select:charging_sessions', [
      { status: 'active', transactionId: 'tx1', stationOnline: true },
    ]);
    expect(
      await svc.aiProposalPreconditionHolds({
        kind: 'session_active',
        params: { sessionId: 's', stationOnline: false },
      }),
    ).toBe(false);
    h.fake.queue('select:charging_sessions', [
      { status: 'completed', transactionId: 'tx1', stationOnline: true },
    ]);
    expect(
      await svc.aiProposalPreconditionHolds({ kind: 'session_active', params: { sessionId: 's' } }),
    ).toBe(false);
  });

  it('station_faulted and station_availability compare the availability', async () => {
    expect(await svc.aiProposalPreconditionHolds({ kind: 'station_faulted', params: {} })).toBe(
      false,
    );
    expect(
      await svc.aiProposalPreconditionHolds({
        kind: 'station_faulted',
        params: { stationId: 's' },
      }),
    ).toBe(false);
    h.fake.queue('select:charging_stations', [{ availability: 'faulted' }]);
    expect(
      await svc.aiProposalPreconditionHolds({
        kind: 'station_faulted',
        params: { stationId: 's' },
      }),
    ).toBe(true);
    h.fake.queue('select:charging_stations', [{ availability: 'available' }]);
    expect(
      await svc.aiProposalPreconditionHolds({
        kind: 'station_availability',
        params: { stationId: 's', availability: 'available' },
      }),
    ).toBe(true);
    h.fake.queue('select:charging_stations', [{ availability: 'available' }]);
    expect(
      await svc.aiProposalPreconditionHolds({
        kind: 'station_availability',
        params: { stationId: 's', availability: 'unavailable' },
      }),
    ).toBe(false);
  });
});

describe('createAiProposal failure', () => {
  it('passes a database error of the insert through and audits nothing', async () => {
    h.fake.queue('select:charging_stations', [{ id: 'sta_1', siteId: 'sit_1' }]);
    h.fake.queue('select:charging_sessions', [{ stationId: 'sta_1' }]);
    h.fake.fail('insert:ai_proposals', new Error('db down'));
    await expect(
      svc.createAiProposal(
        {
          job: 'stuck_sessions',
          insightId: 'ain_1',
          siteId: 'sit_1',
          stationId: 'sta_1',
          sessionId: 'ses_1',
          operationId: 'stopActiveEvseSession',
          method: 'POST',
          path: '/v1/stations/{id}/evses/{evseId}/stop-active-session',
          args: { id: 'sta_1', evseId: 1 },
          expiresAt: new Date(Date.now() + 3_600_000),
          actor: { actor: 'system', actorLabel: 'ai-stuck-sessions' },
        },
        log,
      ),
    ).rejects.toThrow('db down');
    expect(h.audits).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });
});

describe('toAiProposalDto', () => {
  it('maps a row with dates, a valid precondition and result', () => {
    const dto = svc.toAiProposalDto(
      proposal({
        decidedAt: new Date('2026-11-12T01:00:00Z'),
        executedAt: new Date('2026-11-12T02:00:00Z'),
        result: { httpStatus: 200 },
      }),
    );
    expect(dto).toMatchObject({
      job: 'stuck_sessions',
      precondition: { kind: 'session_active', params: { sessionId: 'ses_1' } },
      decidedAt: '2026-11-12T01:00:00.000Z',
      executedAt: '2026-11-12T02:00:00.000Z',
      result: { httpStatus: 200 },
      expiresAt: '2026-11-13T00:00:00.000Z',
    });
  });

  it('drops an unknown job, an invalid precondition and an invalid result', () => {
    const dto = svc.toAiProposalDto(
      proposal({
        job: 'retired_job',
        precondition: { kind: 'nope' },
        result: { httpStatus: 'x' },
      }),
    );
    expect(dto).toMatchObject({
      job: null,
      precondition: null,
      result: null,
      decidedAt: null,
      executedAt: null,
    });
    expect(
      svc.toAiProposalDto(proposal({ job: null, precondition: null })).precondition,
    ).toBeNull();
  });
});
