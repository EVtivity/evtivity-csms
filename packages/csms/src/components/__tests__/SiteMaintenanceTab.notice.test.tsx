// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }, ApiError };
});

vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { SiteMaintenanceTab } from '../SiteMaintenanceTab';

const ACTIVE_WINDOW = {
  id: 'mnt_1',
  status: 'active',
  type: 'scheduled',
  startAt: '2026-11-11T10:00:00.000Z',
  plannedStartAt: '2026-11-11T10:00:00.000Z',
  plannedEndAt: '2026-12-12T10:00:00.000Z',
  affectedStationIds: ['sta_1'],
  activeSessionPolicy: 'ignore',
  customMessage: null,
  reason: 'Cable replacement',
  reservationsCancelledCount: 0,
  sessionsStoppedCount: 0,
  rollout: { offline: { accepted: 1, total: 1 }, reasserted: null, restored: null },
};

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

describe('SiteMaintenanceTab active window notice', () => {
  it('shows the active window as the shared warning Alert with its title and actions', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.endsWith('/maintenance/status')) {
        return Promise.resolve({ current: ACTIVE_WINDOW, upcoming: [] });
      }
      return Promise.resolve({ data: [], total: 0 });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <SiteMaintenanceTab siteId="sit_1" timezone="UTC" />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    const title = await screen.findByText('maintenance.activeNow');
    const alert = title.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.className).toContain('text-warning-text');
    expect(alert?.className).toContain('bg-warning/10');
    expect(title.tagName).toBe('H5');
    expect(alert?.textContent).toContain('Cable replacement');
    expect(alert?.textContent).toContain('common.edit');
    expect(alert?.textContent).toContain('maintenance.endNow');
  });
});
