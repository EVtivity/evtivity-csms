// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import i18next from 'i18next';
import {
  formatDuration,
  formatDurationMinutes,
  formatCo2,
  formatEnergy,
  formatFileSize,
} from '../formatting';

beforeAll(async () => {
  await i18next.init({ lng: 'en', resources: {} });
});

describe('formatDuration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns n/a without a start', () => {
    expect(formatDuration(null, '2026-01-01T00:00:00Z')).toBe('n/a');
  });

  it('shows minutes only under an hour', () => {
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:59:00Z')).toBe('59m');
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe('0m');
  });

  it('shows hours and minutes from an hour on', () => {
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z')).toBe('1h 0m');
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T02:05:00Z')).toBe('2h 5m');
  });

  it('rounds to the nearest minute', () => {
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:10:31Z')).toBe('11m');
  });

  it('measures an ongoing session up to now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T03:30:00Z'));
    expect(formatDuration('2026-01-01T00:00:00Z', null)).toBe('3h 30m');
  });
});

describe('formatDurationMinutes', () => {
  it.each([
    [0, '0m'],
    [59, '59m'],
    [60, '1h'],
    [61, '1h 1m'],
    [150, '2h 30m'],
    [180, '3h'],
  ])('%i -> %s', (minutes, expected) => {
    expect(formatDurationMinutes(minutes)).toBe(expected);
  });
});

describe('unit formatters', () => {
  it('formatCo2 switches to tonnes at 1000 kg', () => {
    expect(formatCo2(999.94)).toBe('999.9 kg');
    expect(formatCo2(1000)).toBe('1.0 t');
    expect(formatCo2(2550)).toBe('2.6 t');
  });

  it('formatEnergy picks Wh, kWh or MWh by size', () => {
    expect(formatEnergy(999.4)).toBe('999 Wh');
    expect(formatEnergy(1000)).toBe('1.0 kWh');
    expect(formatEnergy(99_999_999)).toBe('100,000.0 kWh');
    expect(formatEnergy(100_000_000)).toBe('100.0 MWh');
  });

  it('formatFileSize picks B, KB or MB by size', () => {
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
  });
});
