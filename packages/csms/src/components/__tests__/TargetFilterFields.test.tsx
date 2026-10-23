// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ sites: [], vendors: [], models: [], stations: [] }),
  },
}));

import { TargetFilterFields } from '../TargetFilterFields';

function renderFields(helpText?: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TargetFilterFields
        endpoint="/v1/firmware-campaigns/filter-options"
        queryKeyPrefix={['test-filter']}
        value={{}}
        onChange={() => undefined}
        {...(helpText != null ? { helpText } : {})}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('TargetFilterFields', () => {
  it('shows the configuration template help by default', () => {
    renderFields();
    expect(screen.getByText('configTemplates.targetFilterHelp')).toBeTruthy();
  });

  it('shows the help text of the page that uses it', () => {
    renderFields('Offline stations get the update when they connect.');
    expect(screen.getByText('Offline stations get the update when they connect.')).toBeTruthy();
    expect(screen.queryByText('configTemplates.targetFilterHelp')).toBeNull();
  });

  it('offers the data plan filter only when asked, and sets or clears it', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={client}>
        <TargetFilterFields
          endpoint="/v1/config-templates/filter-options"
          queryKeyPrefix={['test-filter-plan']}
          value={{ siteId: 'site_1', dataPlan: 'cellular' }}
          onChange={onChange}
          showDataPlan
        />
      </QueryClientProvider>,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('dataPlan.title');
    expect(select.value).toBe('cellular');
    fireEvent.change(select, { target: { value: 'wifi_or_wired' } });
    expect(onChange).toHaveBeenLastCalledWith({ siteId: 'site_1', dataPlan: 'wifi_or_wired' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ siteId: 'site_1' });
  });

  it('has no data plan filter by default', () => {
    renderFields();
    expect(screen.queryByLabelText('dataPlan.title')).toBeNull();
  });
});
