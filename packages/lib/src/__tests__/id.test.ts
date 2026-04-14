// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { generateId, ID_PREFIXES } from '../id.js';

describe('generateId', () => {
  it('generates a prefixed nanoid for a known entity', () => {
    const id = generateId('driver');
    expect(id).toMatch(/^drv_[a-z0-9]{12}$/);
  });

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('driver')));
    expect(ids.size).toBe(100);
  });

  it('uses the correct prefix for each entity type', () => {
    for (const [entity, prefix] of Object.entries(ID_PREFIXES)) {
      const id = generateId(entity as keyof typeof ID_PREFIXES);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(id).toHaveLength(prefix.length + 1 + 12);
    }
  });

  it('only contains lowercase alphanumeric characters in the random part', () => {
    const id = generateId('session');
    const randomPart = id.split('_')[1]!;
    expect(randomPart).toMatch(/^[a-z0-9]{12}$/);
  });
});
