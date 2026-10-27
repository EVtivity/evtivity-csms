// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';

/** The marker values the API and the database write for a hidden secret. */
const REDACTED_VALUES = new Set(['<redacted>', '[redacted]']);

export interface AuditFieldChange {
  /** Field key, nested keys one level deep joined with a dot (`address.city`). */
  key: string;
  before: unknown;
  after: unknown;
  /** Whether the value differs between before and after. */
  changed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The snapshot as fields. A non-object snapshot (a bare value) is one field
 * named `value`; nested objects are flattened one level with dotted keys.
 */
function flatten(snapshot: unknown): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  if (snapshot == null) return fields;
  if (!isPlainObject(snapshot)) {
    fields.set('value', snapshot);
    return fields;
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      for (const [inner, innerValue] of Object.entries(value)) {
        fields.set(`${key}.${inner}`, innerValue);
      }
    } else {
      fields.set(key, value);
    }
  }
  return fields;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every field of an audit row's before and after snapshots, in the order they
 * first appear (before first), with whether each changed. A field present on
 * one side only reads `undefined` on the other.
 */
export function auditFieldChanges(before: unknown, after: unknown): AuditFieldChange[] {
  const b = flatten(before);
  const a = flatten(after);
  const keys = [...b.keys(), ...[...a.keys()].filter((k) => !b.has(k))];
  return keys.map((key) => {
    const bv = b.get(key);
    const av = a.get(key);
    return { key, before: bv, after: av, changed: !sameValue(bv, av) };
  });
}

export function isRedactedValue(value: unknown): boolean {
  return typeof value === 'string' && REDACTED_VALUES.has(value);
}

/** A stored field key as words: `carbonRegionCode` -> `Carbon region code`. */
export function humanizeFieldKey(key: string): string {
  const words = key
    .split('.')
    .map((part) =>
      part
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim(),
    )
    .filter((part) => part !== '')
    .join(' ')
    .toLowerCase();
  if (words === '') return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The field's label: an `audit.fields.<key>` translation, else the humanized key. */
export function auditFieldLabel(t: TFunction, key: string): string {
  return t(`audit.fields.${key}`, { defaultValue: humanizeFieldKey(key) });
}
