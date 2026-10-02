// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { price?: string }) => `${key}:${options?.price ?? ''}`,
    i18n: { language: 'en' },
  }),
}));

import { GrossPriceHint } from '../pricing/GrossPriceHint';

describe('GrossPriceHint', () => {
  it('shows the gross price when a tax rate is set', () => {
    const { container } = render(<GrossPriceHint price="0.2152" taxRate="0.19" />);
    expect(container.textContent).toBe('pricing.grossPriceHint:0.2561');
  });

  it('renders nothing without a tax rate or price', () => {
    expect(render(<GrossPriceHint price="0.25" taxRate="" />).container.textContent).toBe('');
    expect(render(<GrossPriceHint price="" taxRate="0.19" />).container.textContent).toBe('');
  });
});
