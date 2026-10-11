// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import ko from '../locales/ko.json';

// Korean: an EV driver is 운전자, never 드라이버 (owner decision 2026-10-11).
// 드라이버 is allowed only where it means a
// software driver; list such keys here with the reason.
const ALLOWED_DRIVER_KEYS: ReadonlySet<string> = new Set<string>();

function flatten(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (node == null || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix === '' ? k : `${prefix}.${k}`),
  );
}

describe('Korean terms (CSMS)', () => {
  it('calls a driver 운전자, never 드라이버', () => {
    const found = flatten(ko)
      .filter(([key, text]) => text.includes('드라이버') && !ALLOWED_DRIVER_KEYS.has(key))
      .map(([key]) => key);
    expect(found).toEqual([]);
  });

  it('uses 운전자 for the driver labels', () => {
    expect(flatten(ko).filter(([, text]) => text.includes('운전자')).length).toBeGreaterThan(100);
  });
});
