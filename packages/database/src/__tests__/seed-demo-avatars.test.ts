// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { generatedAvatarProblem } from '@evtivity/lib/account-avatar';

const writeAudit = vi.fn(async () => undefined);
vi.mock('../lib/audit.js', () => ({ writeAudit }));
vi.mock('../schema/audit.js', () => ({ driverAuditLog: {} }));

const { demoDriverAvatar, seedDemoDriverAvatars } = await import('../seed-demo-avatars.js');

interface Fragment {
  text: string;
  values: unknown[];
}

/** A tagged-template stand-in for postgres.js that records each query's text and values. */
function fakeSql(selectRows: Array<{ id: string }>) {
  const queries: Fragment[] = [];
  const flatten = (strings: TemplateStringsArray, values: unknown[]): Fragment => {
    let text = strings[0] ?? '';
    const out: unknown[] = [];
    values.forEach((v, i) => {
      if (v != null && typeof v === 'object' && 'text' in v && 'values' in v) {
        const f = v as Fragment;
        text += f.text;
        out.push(...f.values);
      } else {
        text += `$${String(out.length + 1)}`;
        out.push(v);
      }
      text += strings[i + 1] ?? '';
    });
    return { text, values: out };
  };
  const sql = ((first: unknown, ...values: unknown[]) => {
    if (Array.isArray(first) && 'raw' in first) {
      const fragment = flatten(first as unknown as TemplateStringsArray, values);
      // A fragment used inside another query.
      if (!/^\s*(SELECT|UPDATE)/.test(fragment.text)) return fragment;
      queries.push(fragment);
      if (fragment.text.trim().startsWith('SELECT')) return Promise.resolve(selectRows);
      return Promise.resolve([{ id: fragment.values.at(-1) }]);
    }
    // sql(list): an IN list.
    return { text: '($list)', values: [first] };
  }) as unknown as postgres.Sql;
  Object.assign(sql, {
    unsafe: (text: string) => ({ text, values: [] }),
    json: (v: unknown) => v,
  });
  return { sql, queries };
}

describe('seedDemoDriverAvatars', () => {
  it('gives a fixed avatar per driver id', () => {
    expect(demoDriverAvatar('drv_verifyshot01')).toEqual(demoDriverAvatar('drv_verifyshot01'));
  });

  it('writes nothing for an empty driver list', async () => {
    const { sql, queries } = fakeSql([]);
    expect(await seedDemoDriverAvatars(sql, null, [])).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it('writes only the demo drivers it is given, only while they have no avatar', async () => {
    writeAudit.mockClear();
    const { sql, queries } = fakeSql([{ id: 'drv_verifyshot01' }]);
    expect(await seedDemoDriverAvatars(sql, null, ['drv_verifyshot01'])).toBe(1);
    const [select, update] = queries;
    expect(select?.text).toContain('avatar_kind IS NULL');
    expect(select?.text).toContain("LIKE '%@example.com'");
    expect(select?.text).toContain('AND id IN ($list)');
    expect(select?.values).toContainEqual(['drv_verifyshot01']);
    expect(update?.text).toContain('avatar_kind IS NULL AND erased_at IS NULL');
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it('reads every demo driver without a list', async () => {
    const { sql, queries } = fakeSql([]);
    await seedDemoDriverAvatars(sql, null);
    expect(queries[0]?.text).not.toContain('id IN');
  });
});

const ids = Array.from({ length: 300 }, (_, i) => `drv_${String(i).padStart(12, '0')}`);

describe('demo driver avatars', () => {
  it('passes the avatar allow-list for every driver and stays the same per driver', () => {
    for (const id of ids) {
      const avatar = demoDriverAvatar(id);
      expect(generatedAvatarProblem(avatar), id).toBeNull();
      expect(demoDriverAvatar(id)).toEqual(avatar);
    }
  });

  it('varies the faces and keeps them ordinary', () => {
    const avatars = ids.map((id) => demoDriverAvatar(id).options);
    expect(new Set(avatars.map((o) => o['topVariant'])).size).toBeGreaterThan(10);
    expect(new Set(avatars.map((o) => o['skinColor'])).size).toBe(5);
    const glasses = avatars.filter((o) => o['accessoriesProbability'] === 100).length;
    expect(glasses).toBeGreaterThan(20);
    expect(glasses).toBeLessThan(120);
    for (const o of avatars) {
      expect(['eyepatch', 'kurt', 'sunglasses', 'wayfarers']).not.toContain(
        o['accessoriesVariant'],
      );
      expect(['hat', 'hijab', 'turban', 'winterHat1']).not.toContain(o['topVariant']);
      expect(o['clothesVariant']).not.toBe('graphicShirt');
      expect(o['topProbability']).toBe(100);
    }
  });
});
