// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';

// Chinese (owner decision 2026-11-04): a charging station is 充电桩 / 充電樁 and
// a site is 充电站 / 充電站, never 站点 / 站點.
function flatten(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (node == null || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix === '' ? k : `${prefix}.${k}`),
  );
}

describe('Chinese terms (CSMS)', () => {
  it.each([
    ['zh', zh, '站点', '充电桩', '充电站'],
    ['zh-TW', zhTW, '站點', '充電樁', '充電站'],
  ] as const)('%s calls a site never by its old term', (_lang, locale, old, station, site) => {
    const entries = flatten(locale);
    expect(entries.filter(([, text]) => text.includes(old)).map(([key]) => key)).toEqual([]);
    expect(entries.find(([key]) => key === 'nav.stations')?.[1]).toContain(station);
    expect(entries.find(([key]) => key === 'nav.sites')?.[1]).toContain(site);
  });
});
