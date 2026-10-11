// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Insight feedback in the insight service (v0.1.45): one vote per user and
// insight, audited only on a change, the note kept out of the audit.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Prev {
  helpful: boolean;
  reason: string | null;
}

const state = vi.hoisted(() => ({
  prev: [] as Prev[],
  upsertRows: [{ insightId: 'ain_1' }] as unknown[],
  deleted: [] as Prev[],
  inserted: [] as Record<string, unknown>[],
  conflictSet: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
}));

vi.mock('@evtivity/database', () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ for: () => ({ limit: () => Promise.resolve(state.prev) }) }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.inserted.push(values);
        return {
          onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
            state.conflictSet.push(config.set);
            return { returning: () => Promise.resolve(state.upsertRows) };
          },
        };
      },
    }),
  };
  return {
    db: {
      transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      delete: () => ({
        where: () => ({ returning: () => Promise.resolve(state.deleted) }),
      }),
    },
    client: {},
    aiInsights: {},
    aiInsightTexts: {},
    aiInsightAuditLog: {},
    aiInsightFeedback: {
      insightId: 'insight_id',
      userId: 'user_id',
      helpful: 'helpful',
      reason: 'reason',
    },
    writeAudit: (_config: unknown, args: Record<string, unknown>) => {
      state.audits.push(args);
      return Promise.resolve();
    },
  };
});
vi.mock('../ai-evidence/state.js', () => ({ currentFingerprints: vi.fn() }));

const { setInsightFeedback, clearInsightFeedback } = await import('../ai-insight.service.js');

const actor = { actor: 'operator' as const, actorUserId: 'usr_1' };

beforeEach(() => {
  state.prev = [];
  state.upsertRows = [{ insightId: 'ain_1' }];
  state.deleted = [];
  state.inserted = [];
  state.conflictSet = [];
  state.audits = [];
});

describe('setInsightFeedback', () => {
  it('TC-AI-FB-01 a first vote is stored and audited', async () => {
    await expect(setInsightFeedback('ain_1', 'usr_1', { helpful: true }, actor)).resolves.toBe(
      'created',
    );
    expect(state.inserted).toEqual([
      { insightId: 'ain_1', userId: 'usr_1', helpful: true, reason: null },
    ]);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: 'feedback_helpful',
      actorUserId: 'usr_1',
      before: null,
      after: { helpful: true, reasonGiven: false },
    });
  });

  it('TC-AI-FB-02 the same vote again writes nothing and no audit row', async () => {
    state.prev = [{ helpful: false, reason: null }];
    await expect(setInsightFeedback('ain_1', 'usr_1', { helpful: false }, actor)).resolves.toBe(
      'unchanged',
    );
    expect(state.inserted).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it('TC-AI-FB-02 a concurrent identical vote that the upsert skips writes no audit row', async () => {
    state.upsertRows = [];
    await expect(setInsightFeedback('ain_1', 'usr_1', { helpful: true }, actor)).resolves.toBe(
      'unchanged',
    );
    expect(state.audits).toEqual([]);
  });

  it('TC-AI-FB-03 a changed vote is audited with the previous vote', async () => {
    state.prev = [{ helpful: true, reason: null }];
    await expect(
      setInsightFeedback('ain_1', 'usr_1', { helpful: false, reason: '  Planned work  ' }, actor),
    ).resolves.toBe('changed');
    expect(state.inserted[0]).toMatchObject({ helpful: false, reason: 'Planned work' });
    expect(state.audits[0]).toMatchObject({
      action: 'feedback_wrong',
      before: { helpful: true, reasonGiven: false },
      after: { helpful: false, reasonGiven: true },
    });
    // The note never goes into the audit.
    expect(JSON.stringify(state.audits)).not.toContain('Planned work');
  });

  it('TC-AI-FB-04 a wrong vote without a reason keeps the stored note; a helpful vote drops it', async () => {
    state.prev = [{ helpful: false, reason: 'Maintenance' }];
    await expect(setInsightFeedback('ain_1', 'usr_1', { helpful: false }, actor)).resolves.toBe(
      'unchanged',
    );
    await expect(
      setInsightFeedback('ain_1', 'usr_1', { helpful: false, reason: ' ' }, actor),
    ).resolves.toBe('changed');
    expect(state.inserted.at(-1)).toMatchObject({ reason: null });
    await setInsightFeedback('ain_1', 'usr_1', { helpful: true }, actor);
    expect(state.inserted.at(-1)).toMatchObject({ helpful: true, reason: null });
  });
});

describe('clearInsightFeedback', () => {
  it('TC-AI-FB-05 removing a vote is audited as cleared; removing none writes nothing', async () => {
    await expect(clearInsightFeedback('ain_1', 'usr_1', actor)).resolves.toBe(false);
    expect(state.audits).toEqual([]);
    state.deleted = [{ helpful: false, reason: 'x' }];
    await expect(clearInsightFeedback('ain_1', 'usr_1', actor)).resolves.toBe(true);
    expect(state.audits[0]).toMatchObject({
      action: 'feedback_cleared',
      before: { helpful: false, reasonGiven: true },
      after: { helpful: null },
    });
  });
});
