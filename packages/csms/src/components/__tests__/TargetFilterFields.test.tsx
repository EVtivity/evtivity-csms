// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
});
