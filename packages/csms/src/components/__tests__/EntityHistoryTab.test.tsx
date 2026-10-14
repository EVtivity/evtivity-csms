// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: h.get } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (d: Date) => d.toISOString(),
}));

import { EntityHistoryTab } from '../EntityHistoryTab';

function renderTab(element: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

beforeEach(() => {
  h.get.mockReset().mockResolvedValue({ data: [], total: 0 });
});

afterEach(() => {
  cleanup();
});

describe('EntityHistoryTab', () => {
  it('lists every row of one entity type', async () => {
    renderTab(<EntityHistoryTab entityType="report_schedule" entityId={null} />);
    await waitFor(() => {
      expect(h.get).toHaveBeenCalledWith('/v1/audit?entityType=report_schedule&page=1&limit=20');
    });
  });

  it('merges related entity types into the same list', async () => {
    renderTab(
      <EntityHistoryTab
        entityType="setting"
        entityId={null}
        relatedEntityTypes={['station_message_template']}
      />,
    );
    await waitFor(() => {
      expect(h.get).toHaveBeenCalledWith(
        '/v1/audit?entityTypes=setting,station_message_template&page=1&limit=20',
      );
    });
  });

  it('lists one entity through the per-entity route', async () => {
    renderTab(<EntityHistoryTab entityType="session" entityId="ses_1" />);
    await waitFor(() => {
      expect(h.get).toHaveBeenCalledWith('/v1/audit/session/ses_1?page=1&limit=20');
    });
  });
});
