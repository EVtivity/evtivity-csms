// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  canRead: true,
  canWriteCards: true,
  fleetEnabled: true,
  allSites: true,
}));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (permission: string) =>
    permission === 'fleetCards:write' ? h.canWriteCards : h.canRead,
  useHasAllSiteAccess: () => h.allSites,
}));
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({ flags: { fleetEnabled: h.fleetEnabled } }),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: h.get } }));

import { TokenFleetSelect } from '../TokenFleetSelect';

function renderSelect(
  onChange: (value: string) => void,
  current?: { id: string; name: string | null },
  value = '',
): void {
  h.get.mockResolvedValue({ data: [{ id: 'flt_1', name: 'Acme Vans' }], total: 1 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TokenFleetSelect id="fleet" value={value} onChange={onChange} current={current ?? null} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.canRead = true;
  h.canWriteCards = true;
  h.fleetEnabled = true;
  h.allSites = true;
});

describe('TokenFleetSelect', () => {
  it('searches the fleets by name and reports the pick', async () => {
    const onChange = vi.fn();
    renderSelect(onChange);
    const field = screen.getByLabelText('tokens.fleet');
    expect(h.get).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'Acme' } });
    const option = await screen.findByRole('option', { name: 'Acme Vans' }, { timeout: 2000 });
    expect(String(h.get.mock.calls[0]?.[0])).toContain('/v1/fleets?');
    expect(String(h.get.mock.calls[0]?.[0])).toContain('search=Acme');
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('flt_1');
  });

  it("shows the card's fleet as the pick and clears it to no fleet", () => {
    const onChange = vi.fn();
    renderSelect(onChange, { id: 'flt_9', name: 'Night Buses' }, 'flt_9');
    const field = screen.getByLabelText<HTMLInputElement>('tokens.fleet');
    expect(field.value).toBe('Night Buses');
    fireEvent.click(screen.getByRole('button', { name: 'common.clear' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('renders nothing while the Fleets feature is off or without fleets:read', () => {
    h.fleetEnabled = false;
    renderSelect(vi.fn());
    expect(screen.queryByLabelText('tokens.fleet')).toBeNull();
    cleanup();
    h.fleetEnabled = true;
    h.canRead = false;
    renderSelect(vi.fn());
    expect(screen.queryByLabelText('tokens.fleet')).toBeNull();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('renders nothing for a site-restricted operator, whom the API refuses a fleet', () => {
    h.allSites = false;
    renderSelect(vi.fn());
    expect(screen.queryByLabelText('tokens.fleet')).toBeNull();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('renders nothing without fleetCards:write, whom the API refuses a fleet', () => {
    h.canWriteCards = false;
    renderSelect(vi.fn());
    expect(screen.queryByLabelText('tokens.fleet')).toBeNull();
    expect(h.get).not.toHaveBeenCalled();
  });
});
