// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { cn, formatCents, formatEnergy, formatDate } from '../utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('foo', undefined, 'bar')).toBe('foo bar');
    const isFalsy = Boolean(0);
    expect(cn('foo', isFalsy && 'bar')).toBe('foo');
  });

  it('deduplicates tailwind classes', () => {
    // twMerge behavior: later class wins
    const result = cn('p-4', 'p-2');
    expect(result).toBe('p-2');
  });
});

describe('formatCents', () => {
  it('returns -- for null', () => {
    expect(formatCents(null)).toBe('--');
  });

  it('returns -- for undefined', () => {
    expect(formatCents(undefined)).toBe('--');
  });

  it('formats 0 as $0.00', () => {
    expect(formatCents(0)).toBe('$0.00');
  });

  it('formats 1999 as $19.99', () => {
    expect(formatCents(1999)).toBe('$19.99');
  });

  it('formats 100 as $1.00', () => {
    expect(formatCents(100)).toBe('$1.00');
  });

  it('formats with EUR currency', () => {
    const result = formatCents(1000, 'EUR');
    expect(result).toContain('10.00');
  });

  it('formats negative values', () => {
    const result = formatCents(-500);
    expect(result).toContain('5.00');
  });
});

describe('formatEnergy', () => {
  it('returns -- for null', () => {
    expect(formatEnergy(null)).toBe('--');
  });

  it('returns -- for undefined', () => {
    expect(formatEnergy(undefined)).toBe('--');
  });

  it('formats string 0 as kWh', () => {
    expect(formatEnergy('0')).toBe('0.00 kWh');
  });

  it('formats string 500 as kWh', () => {
    expect(formatEnergy('500')).toBe('0.50 kWh');
  });

  it('formats string 1000 as kWh', () => {
    expect(formatEnergy('1000')).toBe('1.00 kWh');
  });

  it('formats string 15000 as kWh', () => {
    expect(formatEnergy('15000')).toBe('15.00 kWh');
  });

  it('formats number 2500 as kWh', () => {
    expect(formatEnergy(2500)).toBe('2.50 kWh');
  });

  it('formats string 750 as kWh', () => {
    expect(formatEnergy('750')).toBe('0.75 kWh');
  });
});

describe('formatDate', () => {
  it('returns -- for null', () => {
    expect(formatDate(null)).toBe('--');
  });

  it('returns -- for undefined', () => {
    expect(formatDate(undefined)).toBe('--');
  });

  it('formats ISO date string with month, day, year, and time', () => {
    const result = formatDate('2024-06-15T14:30:00Z');
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/2024/);
  });

  it('formats Date object', () => {
    const date = new Date('2024-01-01T09:00:00Z');
    const result = formatDate(date);
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/2024/);
  });

  it('formats date in specified timezone', () => {
    const result = formatDate('2024-06-15T04:00:00Z', 'America/New_York');
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/2024/);
    expect(result).toMatch(/12:00/);
  });

  it('formats date in UTC timezone', () => {
    const result = formatDate('2024-06-15T14:30:00Z', 'UTC');
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/2:30/);
  });

  it('formats date in Asia/Tokyo timezone', () => {
    const result = formatDate('2024-06-15T14:30:00Z', 'Asia/Tokyo');
    expect(result).toMatch(/Jun/);
    expect(result).toMatch(/15/);
    expect(result).toMatch(/11:30/);
  });

  it('returns -- for null with timezone', () => {
    expect(formatDate(null, 'America/New_York')).toBe('--');
  });
});
