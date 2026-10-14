// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Reservation Explain exists only while the reservation feature is on
// (owner rule v0.1.45, `features/ai-insights.md`).

import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ reservationsOn: false, select: vi.fn() }));
vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  isReservationEnabled: () => Promise.resolve(state.reservationsOn),
  db: { select: state.select },
}));
vi.mock('../lib/site-access.js', () => ({ getUserSiteIds: () => Promise.resolve(null) }));

const { resolveExplainSubject } = await import('../services/ai/engine/explain-context.js');

const access = { userId: 'usr_1', hasPermission: () => Promise.resolve(true) };

describe('reservation Explain gate', () => {
  it('reports a reservation as missing while reservations are off, without reading it', async () => {
    state.reservationsOn = false;
    state.select.mockClear();
    expect(await resolveExplainSubject('reservation', 'res_1', access)).toEqual({
      status: 'missing',
    });
    expect(state.select).not.toHaveBeenCalled();
  });

  it('reads the reservation while reservations are on', async () => {
    state.reservationsOn = true;
    const chain: Record<string, unknown> = {};
    for (const step of ['from', 'leftJoin', 'where']) chain[step] = vi.fn(() => chain);
    chain['limit'] = vi.fn(() => Promise.resolve([]));
    // Without `limit` in the query the awaited chain resolves to no rows.
    chain['then'] = (resolve: (rows: unknown[]) => void) => {
      resolve([]);
    };
    state.select.mockReset();
    state.select.mockReturnValue(chain);
    expect(await resolveExplainSubject('reservation', 'res_1', access)).toEqual({
      status: 'missing',
    });
    expect(state.select).toHaveBeenCalledTimes(1);
  });

  it('refuses a kind that is not a record kind (inherited property names), without reading', async () => {
    state.select.mockClear();
    const hasPermission = vi.fn(() => Promise.resolve(true));
    for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(
        await resolveExplainSubject(kind as 'station', 'x', { userId: 'usr_1', hasPermission }),
      ).toEqual({ status: 'forbidden' });
    }
    expect(hasPermission).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
  });
});
