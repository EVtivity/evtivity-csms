// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {}
  return { api: { get: getMock, post: postMock }, ApiError };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('@/lib/timezone', () => ({ formatDateTime: (value: string) => value }));

import { StationLocalAuthList } from '../StationLocalAuthList';

function renderList(isOnline: boolean): void {
  getMock.mockResolvedValue({
    data: [],
    total: 0,
    localVersion: 1,
    stationVersion: 1,
    lastSyncAt: null,
    lastModifiedAt: null,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StationLocalAuthList stationId="sta_1" isOnline={isOnline} timezone="UTC" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StationLocalAuthList', () => {
  it('shows Push to Station as the primary button with the upload icon, the same height as Add Tokens', () => {
    renderList(true);
    const push = screen.getByRole('button', { name: 'stations.pushToStation' });
    const add = screen.getByRole('button', { name: 'stations.addTokens' });
    expect(push.className).toContain('bg-primary');
    expect(push.className).not.toContain('border-control');
    expect(push.querySelector('svg.lucide-upload')).not.toBeNull();
    expect(push.className).toContain('h-10');
    expect(add.className).toContain('h-10');
    expect(push.hasAttribute('disabled')).toBe(false);
  });

  it('disables Push to Station while the station is offline', () => {
    renderList(false);
    const push = screen.getByRole('button', { name: 'stations.pushToStation' });
    expect(push.hasAttribute('disabled')).toBe(true);
  });
});
