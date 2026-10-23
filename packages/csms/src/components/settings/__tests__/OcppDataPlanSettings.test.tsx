// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts == null ? key : `${key} ${JSON.stringify(opts)}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { OcppDataPlanSettings, planFormFromSettings } from '../OcppDataPlanSettings';

function renderSettings(settings: Record<string, unknown> = {}, path = '/settings'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <OcppDataPlanSettings settings={settings} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.put.mockResolvedValue({});
});

function saveButton(index: number): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: /common.save/ });
  const button = buttons.at(index);
  if (button == null) throw new Error('no Save button');
  return button;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('planFormFromSettings', () => {
  it('takes stored values and falls back to the shipped values', () => {
    const form = planFormFromSettings('cellular', {
      'ocpp.cellular.heartbeatInterval': 7200,
      'ocpp.cellular.dc.sampledMeasurands': 'SoC',
    });
    expect(form.heartbeatInterval).toBe('7200');
    expect(form.dcSampledMeasurands).toBe('SoC');
    expect(form.acMeterValueInterval).toBe('300');
    expect(form.clockAlignedInterval).toBe('0');
  });
});

describe('OcppDataPlanSettings', () => {
  it('shows a tab per plan with AC and DC sections', () => {
    renderSettings();
    expect(screen.getByRole('tab', { name: 'dataPlan.plans.wifi_or_wired' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'dataPlan.plans.cellular' })).toBeTruthy();
    expect(screen.getAllByText('dataPlan.settings.acStations').length).toBeGreaterThan(0);
    expect(screen.getAllByText('dataPlan.settings.dcStations').length).toBeGreaterThan(0);
    const dc = screen.getByLabelText<HTMLInputElement>('settings.ocppMeterValueInterval', {
      selector: '#ocpp-wifi_or_wired-dcMeterValueInterval',
    });
    expect(dc.value).toBe('30');
  });

  it('saves the Wi-Fi or wired keys, numbers as numbers', async () => {
    renderSettings({ 'ocpp.heartbeatInterval': 600 });
    fireEvent.click(saveButton(0));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledTimes(9);
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ocpp.heartbeatInterval', {
      value: 600,
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ocpp.dc.meterValueInterval', {
      value: 30,
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ocpp.csmsPingInterval', {
      value: 120,
    });
  });

  it('saves the Cellular keys from its own tab, with an idle interval of 0', async () => {
    renderSettings({}, '/settings?plan=cellular');
    // The hidden Wi-Fi or wired tab stays mounted but is not reachable by role.
    fireEvent.click(saveButton(0));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledTimes(9);
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ocpp.cellular.clockAlignedInterval', {
      value: 0,
    });
    expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/ocpp.cellular.dc.sampledMeasurands', {
      value: 'Energy.Active.Import.Register,Power.Active.Import,SoC',
    });
  });

  it('refuses a value out of range before saving', () => {
    renderSettings();
    const ping = document.querySelector<HTMLInputElement>('#ocpp-wifi_or_wired-csmsPingInterval');
    if (ping == null) throw new Error('no CSMS ping field');
    fireEvent.change(ping, { target: { value: '10' } });
    fireEvent.click(saveButton(0));
    expect(screen.getByText('validation.invalidValue')).toBeTruthy();
    expect(apiMock.put).not.toHaveBeenCalled();
  });
});
