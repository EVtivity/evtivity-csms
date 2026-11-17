// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import en from '../../i18n/locales/en.json';
import { BUILT_IN_ROLE_NAMES, roleLabel } from '../role-label';

const t = ((key: string): string => {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node != null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
  return typeof value === 'string' ? value : key;
}) as unknown as TFunction;

describe('roleLabel', () => {
  it('names the built-in roles, the Fleet Manager role included', () => {
    expect(BUILT_IN_ROLE_NAMES).toContain('fleet_manager');
    expect(roleLabel('fleet_manager', t)).toBe('Fleet Manager');
    expect(roleLabel('admin', t)).toBe('Admin');
    expect(roleLabel('operator', t)).toBe('Operator');
    expect(roleLabel('viewer', t)).toBe('Viewer');
  });

  it('keeps the name an admin gave a custom role', () => {
    expect(roleLabel('night_shift', t)).toBe('night_shift');
    expect(roleLabel('constructor', t)).toBe('constructor');
  });
});
