// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => false }));
vi.mock('@/components/certificates/CaCertificatesTab', () => ({
  CaCertificatesTab: () => <div>ca-certificates-tab</div>,
}));
vi.mock('@/components/certificates/StationCertificatesTab', () => ({
  StationCertificatesTab: () => <div>station-certificates-tab</div>,
}));
vi.mock('@/components/certificates/CsrRequestsTab', () => ({
  CsrRequestsTab: () => <div>csr-requests-tab</div>,
}));
vi.mock('@/components/EntityHistoryTab', () => ({ EntityHistoryTab: () => null }));

import { Certificates } from '../Certificates';

// The tabs measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Certificates />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Certificates', () => {
  it('shows the disabled notice and loads no certificates while Plug & Charge is off', async () => {
    getMock.mockResolvedValue({ 'pnc.enabled': false });
    renderPage();

    expect(await screen.findByText('errors.PNC_DISABLED')).toBeDefined();
    expect(screen.queryByText('ca-certificates-tab')).toBeNull();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith('/v1/settings');
  });

  it('shows the certificate tabs when Plug & Charge is on', async () => {
    getMock.mockResolvedValue({ 'pnc.enabled': true });
    renderPage();

    expect(await screen.findByText('ca-certificates-tab')).toBeDefined();
    expect(screen.queryByText('errors.PNC_DISABLED')).toBeNull();
  });
});
