// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key}:${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));

import { PowerBar } from '../PowerBar';

afterEach(() => {
  cleanup();
});

describe('PowerBar', () => {
  it('draws no local supply segment without a credit', () => {
    render(<PowerBar currentKw={50} limitKw={100} maxKw={100} />);
    expect(screen.queryByTestId('power-bar-credit')).toBeNull();
    expect(screen.getByText('loadManagement.powerBarMax:{"kw":"100.0"}')).toBeTruthy();
    expect(screen.queryByText(/powerBarLocalSupply/)).toBeNull();
  });

  it('draws the local supply credit as its own segment after the grid capacity', () => {
    render(<PowerBar currentKw={120} limitKw={100} maxKw={100} creditKw={50} />);
    const segment = screen.getByTestId('power-bar-credit');
    // Grid 100 kW of 150 kW in all: the segment starts at two thirds.
    expect(segment.style.left).toMatch(/^66\.6/);
    expect(segment.style.width).toMatch(/^33\.3/);
    expect(screen.getByText('loadManagement.powerBarLocalSupply:{"kw":"50.0"}')).toBeTruthy();
    // The maximum stays the grid capacity.
    expect(screen.getByText('loadManagement.powerBarMax:{"kw":"100.0"}')).toBeTruthy();
  });

  it('colors the load against the grid limit plus the credit', () => {
    const { container } = render(
      <PowerBar currentKw={120} limitKw={100} maxKw={100} creditKw={50} />,
    );
    // 120 of 150 usable kW is 80 percent: yellow, where 120 of 100 would be red.
    expect(container.querySelector('.bg-warning')).not.toBeNull();
    expect(container.querySelector('.bg-destructive')).toBeNull();
  });
});
