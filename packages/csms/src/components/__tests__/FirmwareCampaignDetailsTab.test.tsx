// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useHasAllSiteAccess: () => true,
  useHasPermission: () => true,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => ({
  api: { get: getMock, patch: patchMock, post: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/timezone', () => ({
  formatDateTime: (value: string) => `date:${value}`,
  useUserTimezone: () => 'UTC',
}));

import { FirmwareCampaignDetailsTab, type CampaignDetail } from '../firmware-campaign/DetailsTab';

const MASKED = 'ftp://fw:[redacted]@files.example.com/fw.bin';

const CAMPAIGN: CampaignDetail = {
  id: 'fwc_1',
  name: 'Fall rollout',
  firmwareUrl: MASKED,
  version: null,
  signingCertificate: null,
  signature: null,
  retries: null,
  retryInterval: null,
  installDateTime: null,
  status: 'draft',
  targetFilter: null,
  createdAt: '2026-10-27T00:00:00Z',
  updatedAt: '2026-10-27T00:00:00Z',
};

function renderTab(): void {
  getMock.mockResolvedValue({ sites: [], vendors: [], models: [], stations: [] });
  patchMock.mockResolvedValue(CAMPAIGN);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <FirmwareCampaignDetailsTab campaign={CAMPAIGN} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('FirmwareCampaignDetailsTab', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not send the shown (masked) firmware URL back when it was not changed', async () => {
    renderTab();
    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.change(screen.getByLabelText('common.name'), { target: { value: 'Renamed' } });
    fireEvent.submit(screen.getByLabelText('common.name').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    const body = patchMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['name']).toBe('Renamed');
    expect(body).not.toHaveProperty('firmwareUrl');
  });

  it('sends the firmware URL the operator typed', async () => {
    renderTab();
    fireEvent.click(screen.getByText('common.edit'));
    fireEvent.change(screen.getByLabelText('firmwareCampaigns.firmwareUrl'), {
      target: { value: 'ftp://fw:NewSecret@files.example.com/fw2.bin' },
    });
    fireEvent.submit(screen.getByLabelText('common.name').closest('form') as HTMLFormElement);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledTimes(1);
    });
    const body = patchMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body['firmwareUrl']).toBe('ftp://fw:NewSecret@files.example.com/fw2.bin');
  });
});
