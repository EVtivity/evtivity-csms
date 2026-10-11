// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { reservationAuditReason } from '@evtivity/lib/ai-insights';
import { writeReservationAudit } from '../lib/reservation-audit.js';

function fakeDb(): { db: never; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        rows.push(v);
      }),
    })),
  };
  return { db: db as never, rows };
}

describe('writeReservationAudit reason (v0.1.45, the I1 contract)', () => {
  it('TC-RES-22: stores the reason as after.reason, which reservationAuditReason reads', async () => {
    const { db, rows } = fakeDb();
    await writeReservationAudit(
      {
        reservationId: 'rsv_1',
        action: 'station_rejected',
        actor: 'system',
        statusBefore: 'active',
        statusAfter: 'cancelled',
        reason: 'station_rejected_occupied',
      },
      db,
    );
    expect(rows[0]).toMatchObject({
      reservationId: 'rsv_1',
      action: 'station_rejected',
      after: { status: 'cancelled', reason: 'station_rejected_occupied' },
    });
    expect(reservationAuditReason(rows[0]?.['after'])).toBe('station_rejected_occupied');
  });

  it('writes an after object for a reason alone', async () => {
    const { db, rows } = fakeDb();
    await writeReservationAudit(
      { reservationId: 'rsv_2', action: 'fee_failed', actor: 'system', reason: 'declined' },
      db,
    );
    expect(rows[0]?.['before']).toBeNull();
    expect(reservationAuditReason(rows[0]?.['after'])).toBe('declined');
  });

  it('leaves the reason out when none is given', async () => {
    const { db, rows } = fakeDb();
    await writeReservationAudit(
      { reservationId: 'rsv_3', action: 'expired', actor: 'system', statusAfter: 'expired' },
      db,
    );
    expect(rows[0]?.['after']).not.toHaveProperty('reason');
    expect(reservationAuditReason(rows[0]?.['after'])).toBeNull();
  });

  it('writes no after object without after fields or a reason', async () => {
    const { db, rows } = fakeDb();
    await writeReservationAudit(
      { reservationId: 'rsv_4', action: 'activated', actor: 'system', reason: '' },
      db,
    );
    expect(rows[0]?.['after']).toBeNull();
  });
});
