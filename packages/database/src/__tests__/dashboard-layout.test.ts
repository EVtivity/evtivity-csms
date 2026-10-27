// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { defaultDashboardLayout } from '@evtivity/lib/dashboard-layout';

const calls = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  inserted: [] as unknown[],
  conflict: [] as unknown[],
  deletedWhere: [] as unknown[],
}));

vi.mock('../config.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(calls.selectRows) }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        calls.inserted.push(v);
        return {
          onConflictDoUpdate: (c: unknown) => {
            calls.conflict.push(c);
            return Promise.resolve();
          },
        };
      },
    }),
    delete: () => ({
      where: (w: unknown) => {
        calls.deletedWhere.push(w);
        return Promise.resolve();
      },
    }),
  },
}));

import {
  deleteUserDashboardLayout,
  getUserDashboardLayout,
  saveUserDashboardLayout,
} from '../lib/dashboard-layout.js';
import { userDashboardLayouts } from '../schema/identity.js';

beforeEach(() => {
  calls.selectRows = [];
  calls.inserted.length = 0;
  calls.conflict.length = 0;
  calls.deletedWhere.length = 0;
});

describe('user dashboard layouts', () => {
  it('reads null for a user without a stored layout, else the stored value', async () => {
    expect(await getUserDashboardLayout('usr_1')).toBeNull();
    calls.selectRows = [{ layout: { version: 1, charts: [] } }];
    expect(await getUserDashboardLayout('usr_1')).toEqual({ version: 1, charts: [] });
  });

  it('stores a layout as a full replace keyed by the user', async () => {
    const layout = defaultDashboardLayout();
    await saveUserDashboardLayout('usr_1', layout);
    expect(calls.inserted).toEqual([{ userId: 'usr_1', layout }]);
    const conflict = calls.conflict[0] as { target: unknown[]; set: Record<string, unknown> };
    expect(conflict.target).toEqual([userDashboardLayouts.userId]);
    expect(conflict.set['layout']).toBe(layout);
    expect(conflict.set['updatedAt']).toBeInstanceOf(Date);
  });

  it('deletes the layout of the user', async () => {
    await deleteUserDashboardLayout('usr_1');
    expect(calls.deletedWhere).toHaveLength(1);
  });
});
