// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  auditFieldChanges,
  auditFieldLabel,
  humanizeFieldKey,
  isRedactedValue,
} from '../audit-diff';

describe('auditFieldChanges', () => {
  it('lists the union of keys and marks the changed ones', () => {
    const changes = auditFieldChanges(
      { name: 'Old', city: 'Berlin', gone: 1 },
      { name: 'New', city: 'Berlin', added: true },
    );
    expect(changes).toEqual([
      { key: 'name', before: 'Old', after: 'New', changed: true },
      { key: 'city', before: 'Berlin', after: 'Berlin', changed: false },
      { key: 'gone', before: 1, after: undefined, changed: true },
      { key: 'added', before: undefined, after: true, changed: true },
    ]);
  });

  it('flattens nested objects one level and compares arrays by value', () => {
    const changes = auditFieldChanges(
      { address: { city: 'A', zip: '1' }, tags: ['x', 'y'], deep: { a: { b: 1 } } },
      { address: { city: 'B', zip: '1' }, tags: ['x', 'y'], deep: { a: { b: 2 } } },
    );
    const byKey = Object.fromEntries(changes.map((c) => [c.key, c.changed]));
    expect(byKey).toEqual({
      'address.city': true,
      'address.zip': false,
      tags: false,
      'deep.a': true,
    });
  });

  it('shows a created row as after only and a deleted row as before only', () => {
    expect(auditFieldChanges(null, { name: 'A' })).toEqual([
      { key: 'name', before: undefined, after: 'A', changed: true },
    ]);
    expect(auditFieldChanges({ name: 'A' }, null)).toEqual([
      { key: 'name', before: 'A', after: undefined, changed: true },
    ]);
    expect(auditFieldChanges(null, null)).toEqual([]);
  });

  it('reads a bare value as one field', () => {
    expect(auditFieldChanges(1, 2)).toEqual([{ key: 'value', before: 1, after: 2, changed: true }]);
  });
});

describe('field labels', () => {
  it('humanizes stored keys', () => {
    expect(humanizeFieldKey('carbonRegionCode')).toBe('Carbon region code');
    expect(humanizeFieldKey('max_power_kw')).toBe('Max power kw');
    expect(humanizeFieldKey('address.postalCode')).toBe('Address postal code');
    expect(humanizeFieldKey('OCPPVersion')).toBe('Ocpp version');
  });

  it('uses a translation when one exists, else the humanized key', () => {
    const t = ((key: string, opts: { defaultValue: string }) =>
      key === 'audit.fields.name' ? 'Name' : opts.defaultValue) as unknown as TFunction;
    expect(auditFieldLabel(t, 'name')).toBe('Name');
    expect(auditFieldLabel(t, 'siteId')).toBe('Site id');
  });

  it('recognizes the redaction markers', () => {
    expect(isRedactedValue('<redacted>')).toBe(true);
    expect(isRedactedValue('[redacted]')).toBe(true);
    expect(isRedactedValue('redacted')).toBe(false);
    expect(isRedactedValue(null)).toBe(false);
  });
});
