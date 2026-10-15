// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiProposalDtoSchema } from '@evtivity/lib/ai-proposals';

const inserted: unknown[] = [];
let returning: unknown[] = [];
const audits: unknown[] = [];
const publishes: unknown[] = [];

/** What the target lookups return: the station (by OCPP id, id or session), then the session. */
let stationRows: unknown[] = [];
let sessionRows: unknown[] = [];
/** What the session_active precondition reads: the session and its station's connection. */
let preconditionRows: unknown[] = [];
/** What an update (reject) returns. */
let updated: unknown[] = [];
const closed: unknown[] = [];
const markedPending: string[] = [];
const insightPublishes: string[] = [];

/** Whether the insight is still open when its action is inserted. */
let insightOpen = true;
let rolledBack = false;

vi.mock('@evtivity/database', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const { db } = await import('@evtivity/database');
      try {
        return await fn(db);
      } catch (err) {
        rolledBack = true;
        throw err;
      }
    },
    select: (fields: Record<string, unknown>) => {
      const rows = () =>
        'siteId' in fields
          ? stationRows
          : 'stationOnline' in fields
            ? preconditionRows
            : sessionRows;
      return {
        from: () => ({
          where: () => Promise.resolve(rows()),
          innerJoin: () => ({ where: () => Promise.resolve(rows()) }),
        }),
      };
    },
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve(updated) }) }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        inserted.push(values);
        return {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve(returning) }),
        };
      },
    }),
  },
  aiProposals: {
    id: 'id',
    dedupKey: 'dedup_key',
    status: 'status',
    decidedAt: 'decided_at',
    expiresAt: 'expires_at',
  },
  aiProposalAuditLog: {},
  chargingSessions: {
    id: 'id',
    stationId: 'station_id',
    status: 'status',
    transactionId: 'transaction_id',
  },
  chargingStations: {
    id: 'id',
    siteId: 'site_id',
    stationId: 'station_id',
    isOnline: 'is_online',
    availability: 'availability',
  },
  writeAudit: (_config: unknown, args: unknown) => {
    audits.push(args);
    return Promise.resolve();
  },
}));

vi.mock('@evtivity/lib/pubsub-instance', () => ({
  getPubSub: () => ({
    publish: (channel: string, payload: string) => {
      publishes.push({ channel, payload: JSON.parse(payload) as unknown });
      return Promise.resolve();
    },
  }),
}));

vi.mock('../ai-insight.service.js', () => ({
  AI_INSIGHT_UPDATED_EVENT: 'ai.insight.updated',
  closeActionInsight: (...args: unknown[]) => {
    closed.push(args.slice(0, 3));
    return Promise.resolve(true);
  },
  markInsightActionPending: (_tx: unknown, insightId: string) => {
    markedPending.push(insightId);
    return Promise.resolve(
      insightOpen ? { id: insightId, siteId: null, stationId: null, sessionId: null } : null,
    );
  },
  publishInsightUpdated: (_pubsub: unknown, row: { id: string }) => {
    insightPublishes.push(row.id);
    return Promise.resolve();
  },
}));

const {
  createAiProposal,
  rejectAiProposal,
  toAiProposalDto,
  aiProposalPreconditionHolds,
  AiProposalInputError,
} = await import('../ai-proposal.service.js');
type Input = Parameters<typeof createAiProposal>[0];

function input(overrides: Partial<Input> = {}): Input {
  return {
    job: 'stuck_sessions',
    insightId: 'ins_000000000001',
    siteId: 'sit_000000000001',
    stationId: 'sta_000000000001',
    sessionId: 'ses_000000000001',
    operationId: 'stopActiveEvseSession',
    method: 'POST',
    path: '/v1/stations/{id}/evses/{evseId}/stop-active-session',
    args: { id: 'sta_000000000001', evseId: 1 },
    expiresAt: new Date(Date.now() + 3_600_000),
    actor: { actor: 'system', actorLabel: 'ai-stuck-sessions' },
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'apr_000000000001',
    job: 'stuck_sessions',
    insightId: 'ins_000000000001',
    workerRunId: null,
    siteId: 'sit_000000000001',
    stationId: 'sta_000000000001',
    sessionId: 'ses_000000000001',
    operationId: 'stopActiveEvseSession',
    method: 'POST',
    path: '/v1/stations/{id}/evses/{evseId}/stop-active-session',
    args: { id: 'sta_000000000001', evseId: 1 },
    argsHash: 'h',
    summary: {},
    precondition: { kind: 'session_active', params: { sessionId: 'ses_000000000001' } },
    dedupKey: null,
    status: 'pending',
    expiresAt: new Date('2026-10-10T12:00:00Z'),
    decidedBy: null,
    decidedAt: null,
    executedAt: null,
    result: null,
    createdAt: new Date('2026-10-10T10:00:00Z'),
    updatedAt: new Date('2026-10-10T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  inserted.length = 0;
  audits.length = 0;
  publishes.length = 0;
  closed.length = 0;
  markedPending.length = 0;
  insightPublishes.length = 0;
  insightOpen = true;
  rolledBack = false;
  returning = [];
  updated = [];
  stationRows = [{ id: 'sta_000000000001', siteId: 'sit_000000000001' }];
  sessionRows = [{ stationId: 'sta_000000000001' }];
  preconditionRows = [];
});

describe('createAiProposal', () => {
  it('stores the args hash and its insight, audits, publishes the update and marks the insight pending', async () => {
    returning = [row()];
    const created = await createAiProposal(input());
    expect(created?.id).toBe('apr_000000000001');
    expect(inserted[0]).toMatchObject({
      argsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      insightId: 'ins_000000000001',
    });
    expect(audits).toEqual([expect.objectContaining({ action: 'created', actor: 'system' })]);
    expect(publishes).toEqual([
      {
        channel: 'csms_events',
        payload: {
          eventType: 'ai.insight.updated',
          insightId: 'ins_000000000001',
          siteId: 'sit_000000000001',
          stationId: 'sta_000000000001',
          sessionId: 'ses_000000000001',
        },
      },
    ]);
    expect(closed).toHaveLength(0);
    // The insight's one status moves to pending through the insight service,
    // in the insert's transaction, and is published after the commit.
    expect(markedPending).toEqual(['ins_000000000001']);
    expect(insightPublishes).toEqual(['ins_000000000001']);
    expect(rolledBack).toBe(false);
  });

  it('rolls the action back without side effects when its insight is no longer open', async () => {
    returning = [row()];
    insightOpen = false;
    expect(await createAiProposal(input())).toBeNull();
    expect(rolledBack).toBe(true);
    expect(audits).toHaveLength(0);
    expect(publishes).toHaveLength(0);
    expect(insightPublishes).toHaveLength(0);
  });

  it('returns null without side effects when a pending proposal has the same dedup key', async () => {
    returning = [];
    expect(await createAiProposal(input({ dedupKey: 'stuck_sessions:ses_1' }))).toBeNull();
    expect(audits).toHaveLength(0);
    expect(publishes).toHaveLength(0);
    expect(markedPending).toHaveLength(0);
  });

  it('TC-AI-WK-05: refuses a worker proposal outside the closed action set', async () => {
    for (const bad of [
      input({ operationId: 'updateTariff', path: '/v1/tariffs/{id}', method: 'PATCH' }),
      input({
        operationId: 'ocppv21_Reset',
        path: '/v1/ocpp/commands/v21/Reset',
        args: { stationId: 'CS-1', type: 'Immediate' },
      }),
      input({ job: 'other' as never }),
      input({ insightId: '' }),
    ]) {
      await expect(createAiProposal(bad)).rejects.toBeInstanceOf(AiProposalInputError);
    }
    expect(inserted).toHaveLength(0);
  });

  it('requires an expiry in the future', async () => {
    await expect(
      createAiProposal(input({ expiresAt: new Date(Date.now() - 1) })),
    ).rejects.toBeInstanceOf(AiProposalInputError);
  });
});

describe('TC-AI-IA-04 an ended action closes its insight', () => {
  it('a reject moves the insight through the insight service as the rejecting user', async () => {
    updated = [row({ status: 'rejected', decidedBy: 'usr_000000000001' })];
    const result = await rejectAiProposal('apr_000000000001', {
      actor: 'operator',
      actorUserId: 'usr_000000000001',
    });
    expect(result.kind).toBe('rejected');
    expect(closed).toEqual([
      ['ins_000000000001', 'rejected', { actor: 'operator', actorUserId: 'usr_000000000001' }],
    ]);
    expect(publishes[0]).toMatchObject({
      payload: { eventType: 'ai.insight.updated', insightId: 'ins_000000000001' },
    });
  });
});

describe('the proposal target comes from the station in the arguments (P11)', () => {
  it('stores the station and site of the named station', async () => {
    returning = [row()];
    await createAiProposal(input());
    expect(inserted[0]).toMatchObject({
      siteId: 'sit_000000000001',
      stationId: 'sta_000000000001',
      sessionId: 'ses_000000000001',
    });
  });

  it('refuses a site, station or session that does not match the named station', async () => {
    for (const bad of [
      input({ siteId: 'sit_000000000002' }),
      input({ siteId: null }),
      input({ stationId: 'sta_000000000002' }),
    ]) {
      await expect(createAiProposal(bad)).rejects.toBeInstanceOf(AiProposalInputError);
    }
    sessionRows = [{ stationId: 'sta_000000000002' }];
    await expect(createAiProposal(input())).rejects.toBeInstanceOf(AiProposalInputError);
    stationRows = [];
    await expect(createAiProposal(input())).rejects.toBeInstanceOf(AiProposalInputError);
    expect(inserted).toHaveLength(0);
  });
});

describe('the CSMS end targets the session in its arguments (P11)', () => {
  const end = (overrides: Partial<Input> = {}) =>
    input({
      operationId: 'endSession',
      path: '/v1/sessions/{id}/end',
      args: { id: 'ses_000000000001' },
      ...overrides,
    });

  it("stores the session and its station's site", async () => {
    returning = [row()];
    await createAiProposal(end());
    expect(inserted[0]).toMatchObject({
      operationId: 'endSession',
      siteId: 'sit_000000000001',
      stationId: 'sta_000000000001',
      sessionId: 'ses_000000000001',
    });
  });

  it('refuses a session or site that does not match the argument', async () => {
    for (const bad of [
      end({ sessionId: 'ses_000000000002' }),
      end({ siteId: 'sit_000000000002' }),
      end({ stationId: 'sta_000000000002' }),
    ]) {
      await expect(createAiProposal(bad)).rejects.toBeInstanceOf(AiProposalInputError);
    }
    stationRows = [];
    await expect(createAiProposal(end())).rejects.toBeInstanceOf(AiProposalInputError);
    expect(inserted).toHaveLength(0);
  });
});

describe('session_active precondition and the station connection', () => {
  const precondition = (stationOnline?: boolean) => ({
    kind: 'session_active' as const,
    params: {
      sessionId: 'ses_000000000001',
      transactionId: 'tx-1',
      ...(stationOnline === undefined ? {} : { stationOnline }),
    },
  });

  it('holds while the session is active and the station connection is the one chosen for', async () => {
    preconditionRows = [{ status: 'active', transactionId: 'tx-1', stationOnline: false }];
    expect(await aiProposalPreconditionHolds(precondition(false))).toBe(true);
    preconditionRows = [{ status: 'active', transactionId: 'tx-1', stationOnline: true }];
    expect(await aiProposalPreconditionHolds(precondition(true))).toBe(true);
  });

  it('fails a CSMS end whose station came back online, and a stop whose station went offline', async () => {
    preconditionRows = [{ status: 'active', transactionId: 'tx-1', stationOnline: true }];
    expect(await aiProposalPreconditionHolds(precondition(false))).toBe(false);
    preconditionRows = [{ status: 'active', transactionId: 'tx-1', stationOnline: false }];
    expect(await aiProposalPreconditionHolds(precondition(true))).toBe(false);
  });

  it('ignores the connection for an action stored without it, and fails an ended session', async () => {
    preconditionRows = [{ status: 'active', transactionId: 'tx-1', stationOnline: false }];
    expect(await aiProposalPreconditionHolds(precondition())).toBe(true);
    preconditionRows = [{ status: 'completed', transactionId: 'tx-1', stationOnline: false }];
    expect(await aiProposalPreconditionHolds(precondition(false))).toBe(false);
    preconditionRows = [{ status: 'active', transactionId: 'tx-2', stationOnline: false }];
    expect(await aiProposalPreconditionHolds(precondition(false))).toBe(false);
    preconditionRows = [];
    expect(await aiProposalPreconditionHolds(precondition(false))).toBe(false);
  });
});

describe('toAiProposalDto', () => {
  it('matches the shared DTO contract', () => {
    const dto = toAiProposalDto(row() as never);
    expect(aiProposalDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.expiresAt).toBe('2026-10-10T12:00:00.000Z');
    expect(dto.insightId).toBe('ins_000000000001');
    expect(dto).not.toHaveProperty('source');
  });

  it('drops a stored precondition or result that no longer parses', () => {
    const dto = toAiProposalDto(row({ precondition: { kind: 'other' }, result: 'x' }) as never);
    expect(dto.precondition).toBeNull();
    expect(dto.result).toBeNull();
  });
});
