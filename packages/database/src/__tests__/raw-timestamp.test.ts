// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { toDate, toDateOrNull, toIsoOrNull } from '../lib/raw-timestamp.js';

// The shape the shared client returns for a timestamptz column in a raw query.
const PG_TEXT = '2026-10-10 10:49:38.215861+00';

describe('raw-timestamp', () => {
  it('maps postgres timestamptz text to a Date', () => {
    expect(toDate(PG_TEXT).toISOString()).toBe('2026-10-10T10:49:38.215Z');
  });

  it('maps a non-UTC offset correctly', () => {
    expect(toDate('2026-10-10 06:49:38+05:30').toISOString()).toBe('2026-10-10T01:19:38.000Z');
  });

  it('returns a Date unchanged', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(toDate(d)).toBe(d);
  });

  it('throws on an unparsable value', () => {
    expect(() => toDate('not a date')).toThrow(TypeError);
  });

  it('maps null and undefined to null', () => {
    expect(toDateOrNull(null)).toBeNull();
    expect(toDateOrNull(undefined)).toBeNull();
    expect(toDateOrNull(PG_TEXT)?.getTime()).toBe(Date.parse('2026-10-10T10:49:38.215Z'));
  });

  it('formats as ISO 8601', () => {
    expect(toIsoOrNull(PG_TEXT)).toBe('2026-10-10T10:49:38.215Z');
    expect(toIsoOrNull(null)).toBeNull();
  });
});
