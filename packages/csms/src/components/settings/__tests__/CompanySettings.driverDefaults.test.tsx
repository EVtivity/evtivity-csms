// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

// Settings > Company sets the language and distance unit new drivers start with.

const { get, put } = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({})),
  put: vi.fn(() => Promise.resolve({})),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({
  api: { get, put, post: vi.fn(), delete: vi.fn() },
  getApiErrorFieldDetails: () => ({}),
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { CompanySettings } from '../CompanySettings';

function mount(settings: Record<string, unknown>): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <CompanySettings settings={settings} svgDataUri={null} hasIcon={false} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function select(label: string): HTMLSelectElement {
  return screen.getByLabelText(label);
}

function savedValue(key: string): unknown {
  const call = put.mock.calls.find((c) => (c as unknown[])[0] === `/v1/settings/${key}`) as
    | [string, { value: unknown }]
    | undefined;
  return call?.[1].value;
}

beforeEach(() => {
  put.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('Company settings driver defaults', () => {
  it('shows the stored driver language and distance unit', () => {
    mount({
      'system.timezone': 'Europe/Berlin',
      'system.driverLanguage': 'de',
      'system.distanceUnit': 'km',
    });
    expect(select('settings.companyTimezone').value).toBe('Europe/Berlin');
    expect(select('settings.driverLanguage').value).toBe('de');
    expect(select('settings.driverDistanceUnit').value).toBe('km');
    expect(screen.getByText('settings.driverLanguageHelper')).toBeTruthy();
    expect(screen.getByText('settings.driverDistanceUnitHelper')).toBeTruthy();
  });

  it('shows en and miles when nothing valid is stored', () => {
    mount({ 'system.driverLanguage': 'fr' });
    expect(select('settings.driverLanguage').value).toBe('en');
    expect(select('settings.driverDistanceUnit').value).toBe('miles');
    expect(select('settings.companyTimezone').value).toBe('America/New_York');
  });

  it('saves both with the rest of the company settings', async () => {
    mount({});
    fireEvent.change(select('settings.companyTimezone'), { target: { value: 'Asia/Seoul' } });
    fireEvent.change(select('settings.driverLanguage'), { target: { value: 'zh-TW' } });
    fireEvent.change(select('settings.driverDistanceUnit'), { target: { value: 'km' } });
    const save = screen.getAllByRole('button', { name: 'common.save' })[0];
    if (save == null) throw new Error('no Save button');
    fireEvent.click(save);
    await waitFor(() => {
      expect(savedValue('system.driverLanguage')).toBe('zh-TW');
    });
    expect(savedValue('system.distanceUnit')).toBe('km');
    expect(savedValue('system.timezone')).toBe('Asia/Seoul');
  });
});
