// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

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

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label);
}

function clickSave(): void {
  const save = screen.getAllByRole('button', { name: 'common.save' })[0];
  if (save == null) throw new Error('no Save button');
  fireEvent.click(save);
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

describe('Company settings charger plate colors', () => {
  it('shows the stored colors and the brand color for an empty field', () => {
    mount({ 'company.themeColor': '#112233', 'company.chargerColorAc': '#00aa55' });
    expect(field('settings.chargerColorAc').value).toBe('#00aa55');
    expect(field('settings.chargerColorDc').value).toBe('');
    expect(field('settings.chargerColorDc').placeholder).toBe('#112233');
    expect(field('settings.chargerColorDcPicker').value).toBe('#112233');
    expect(field('settings.chargerColorAcPicker').value).toBe('#00aa55');
    expect(screen.getByText('settings.chargerColorAcDescription')).toBeTruthy();
    expect(screen.getByText('settings.chargerColorDcDescription')).toBeTruthy();
  });

  it('saves both colors with the rest of the company settings', async () => {
    mount({ 'company.themeColor': '#112233' });
    fireEvent.change(field('settings.chargerColorAc'), { target: { value: ' #FF8800 ' } });
    fireEvent.change(field('settings.chargerColorDcPicker'), { target: { value: '#334455' } });
    clickSave();
    await waitFor(() => {
      expect(savedValue('company.chargerColorAc')).toBe('#FF8800');
    });
    expect(savedValue('company.chargerColorDc')).toBe('#334455');
    expect(savedValue('company.themeColor')).toBe('#112233');
  });

  it('saves an empty field, which follows the brand color', async () => {
    mount({ 'company.chargerColorAc': '#00aa55' });
    const [clear] = screen.getAllByRole('button', { name: 'settings.chargerColorClear' });
    if (clear == null) throw new Error('no clear button');
    fireEvent.click(clear);
    expect(field('settings.chargerColorAc').value).toBe('');
    clickSave();
    await waitFor(() => {
      expect(savedValue('company.chargerColorAc')).toBe('');
    });
  });

  it('refuses a value that is not a #rrggbb color before sending anything', () => {
    mount({});
    fireEvent.change(field('settings.chargerColorDc'), { target: { value: 'blue' } });
    expect(screen.queryByText('validation.hexColor')).toBeNull();
    clickSave();
    expect(screen.getByText('validation.hexColor')).toBeTruthy();
    expect(field('settings.chargerColorDc').getAttribute('aria-invalid')).toBe('true');
    expect(put).not.toHaveBeenCalled();
  });
});
