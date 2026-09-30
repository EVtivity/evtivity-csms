// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ApexOptions } from 'apexcharts';
import i18next from 'i18next';

const captured: { options: ApexOptions | null } = { options: null };

vi.mock('react-apexcharts', () => ({
  default: (props: { options: ApexOptions }) => {
    captured.options = props.options;
    return null;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: i18next.language },
  }),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: (selector: (s: { theme: string }) => unknown) => selector({ theme: 'light' }),
}));

import { StationStatusChart } from '../charts/StationStatusChart';

function donutLabel(value: number): string {
  const dataLabels = captured.options?.dataLabels as
    | { formatter?: (val: number) => string }
    | undefined;
  return dataLabels?.formatter?.(value) ?? '';
}

describe('StationStatusChart', () => {
  beforeAll(async () => {
    await i18next.init({ lng: 'en', resources: {} });
  });

  afterEach(async () => {
    cleanup();
    await i18next.changeLanguage('en');
  });

  it('formats donut percentages in the UI language', async () => {
    await i18next.changeLanguage('de');
    render(<StationStatusChart data={[{ status: 'available', count: 3 }]} />);

    expect(donutLabel(15.8333)).toBe('15,8%');
  });

  it('keeps English formatting for English', () => {
    render(<StationStatusChart data={[{ status: 'available', count: 3 }]} />);

    expect(donutLabel(15.8333)).toBe('15.8%');
  });
});
