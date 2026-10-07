// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { get: getMock } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// jsdom has no ResizeObserver; the Tabs list observes its width for scroll buttons.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

import { RoamingLayout } from '../RoamingLayout';

function Partners(): React.JSX.Element {
  return <p>partners page</p>;
}

function renderRoaming(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/roaming/partners']}>
        <Routes>
          <Route path="/roaming" element={<RoamingLayout />}>
            <Route path="partners" element={<Partners />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('RoamingLayout', () => {
  it('shows the roaming-off state and no roaming page when roaming is disabled', async () => {
    getMock.mockResolvedValue({ roamingEnabled: false });
    renderRoaming();
    expect(await screen.findByText('roaming.disabled.title')).toBeTruthy();
    expect(screen.queryByText('partners page')).toBeNull();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('/v1/portal/features');
  });

  it('renders the roaming pages when roaming is enabled', async () => {
    getMock.mockResolvedValue({ roamingEnabled: true });
    renderRoaming();
    expect(await screen.findByText('partners page')).toBeTruthy();
    expect(screen.queryByText('roaming.disabled.title')).toBeNull();
  });

  it('renders the roaming pages when the feature flags cannot be read', async () => {
    getMock.mockRejectedValue(new Error('forbidden'));
    renderRoaming();
    expect(await screen.findByText('partners page')).toBeTruthy();
  });
});
