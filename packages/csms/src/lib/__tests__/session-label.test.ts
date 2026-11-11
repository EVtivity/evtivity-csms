// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { sessionLabel } from '@/lib/session-label';
import { applyAlwaysVisible, type ColumnMeta } from '@/lib/column-visibility';

const t = ((key: string) => key) as unknown as TFunction;

describe('sessionLabel', () => {
  it('names a session by its station, start time and transaction number', () => {
    const label = sessionLabel(
      t,
      { stationOcppId: 'CS-001', startedAt: '2026-11-11T10:00:00.000Z', transactionId: '42' },
      'UTC',
    );
    expect(label.startsWith('CS-001, ')).toBe(true);
    expect(label).toContain('2026');
    expect(label.endsWith(', #42')).toBe(true);
  });

  it('falls back to a plain word, never an id, when nothing readable is known', () => {
    expect(sessionLabel(t, { stationOcppId: null, startedAt: null }, 'UTC')).toBe(
      'common.sessionFallback',
    );
  });
});

describe('applyAlwaysVisible', () => {
  const columns: ColumnMeta[] = [
    {
      key: 'name',
      label: 'n',
      defaultVisible: true,
      defaultVisibleMobile: true,
      alwaysVisible: true,
    },
    { key: 'city', label: 'c', defaultVisible: true, defaultVisibleMobile: false },
  ];

  it('drops a stored column a later release removed and keeps the user choices', () => {
    expect(applyAlwaysVisible(columns, { id: true, name: false, city: false })).toEqual({
      name: true,
      city: false,
    });
  });
});
