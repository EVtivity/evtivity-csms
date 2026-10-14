// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { writeCsmsSessionAudit } from '../lib/session-csms-audit.js';
import { sessionAuditLog } from '../schema/audit.js';

function fakeDb(): { db: never; rows: Array<Record<string, unknown>>; tables: unknown[] } {
  const rows: Array<Record<string, unknown>> = [];
  const tables: unknown[] = [];
  const db = {
    insert: vi.fn((table: unknown) => {
      tables.push(table);
      return {
        values: vi.fn(async (v: Record<string, unknown>) => {
          rows.push(v);
        }),
      };
    }),
  };
  return { db: db as never, rows, tables };
}

describe('writeCsmsSessionAudit', () => {
  it('writes a session audit row with the actor, label and state', async () => {
    const { db, rows, tables } = fakeDb();
    await writeCsmsSessionAudit(
      {
        sessionId: 'ses_1',
        action: 'faulted',
        actor: 'ocpp',
        actorLabel: 'PaymentFailed',
        before: { status: 'active' },
        after: { status: 'faulted', stoppedReason: 'PaymentFailed', finalCostCents: 0 },
        notes: 'RequestStopTransaction sent for transaction tx-1',
      },
      db,
    );
    expect(tables).toEqual([sessionAuditLog]);
    expect(rows[0]).toMatchObject({
      sessionId: 'ses_1',
      sessionIdSnapshot: 'ses_1',
      action: 'faulted',
      actor: 'ocpp',
      actorLabel: 'PaymentFailed',
      before: { status: 'active' },
      after: { status: 'faulted', stoppedReason: 'PaymentFailed', finalCostCents: 0 },
      notes: 'RequestStopTransaction sent for transaction tx-1',
    });
  });

  it('defaults before and notes to null and cuts the label to the column width', async () => {
    const { db, rows } = fakeDb();
    await writeCsmsSessionAudit(
      {
        sessionId: 'ses_2',
        action: 'stopped_by_csms',
        actor: 'system',
        actorLabel: 'x'.repeat(150),
        after: { command: 'RequestStopTransaction' },
      },
      db,
    );
    expect(rows[0]?.['before']).toBeNull();
    expect(rows[0]?.['notes']).toBeNull();
    expect(rows[0]?.['actorLabel']).toHaveLength(100);
  });

  it('fails open: an insert error is logged, not thrown', async () => {
    const db = {
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.reject(new Error('db down'))) })),
    };
    const warn = vi.fn();
    await expect(
      writeCsmsSessionAudit(
        { sessionId: 'ses_3', action: 'faulted', actor: 'system', actorLabel: 'job', after: {} },
        db as never,
        { warn },
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
