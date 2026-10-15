// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock, canWrite, rows } = vi.hoisted(() => ({
  postMock: vi.fn(),
  canWrite: { value: true },
  rows: { value: [] as Array<Record<string, unknown>> },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: postMock, patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: () => canWrite.value,
}));
vi.mock('@/lib/timezone', () => ({
  formatDateTime: (v: string) => v,
  useUserTimezone: () => 'UTC',
}));
vi.mock('@/hooks/use-paginated-query', () => ({
  usePaginatedQuery: () => ({
    data: rows.value,
    isLoading: false,
    page: 1,
    totalPages: 1,
    setPage: vi.fn(),
  }),
}));

import { RoamingCdrs } from '../RoamingCdrs';

function cdr(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    partnerId: 'opr_1',
    ocpiCdrId: 'CDR-1',
    chargingSessionId: 'ses_1',
    totalEnergy: '10',
    totalCost: '4',
    currency: 'EUR',
    isCredit: false,
    hasCredit: false,
    supersededAt: null,
    pushStatus: 'sent',
    createdAt: '2026-10-01T00:00:00Z',
    partnerName: 'Peer',
    ...over,
  };
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RoamingCdrs />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canWrite.value = true;
  rows.value = [];
});

describe('Roaming CDRs actions', () => {
  it('offers credit, then reissue after a credit, and a push retry for a failed CDR', () => {
    rows.value = [
      cdr({ id: 1, ocpiCdrId: 'CDR-1' }),
      cdr({ id: 2, ocpiCdrId: 'CDR-2', hasCredit: true, pushStatus: 'failed' }),
      // A received CDR (no session) and a superseded one offer nothing.
      cdr({ id: 3, ocpiCdrId: 'CDR-3', chargingSessionId: null }),
      cdr({ id: 4, ocpiCdrId: 'CDR-4', hasCredit: true, supersededAt: '2026-10-02T00:00:00Z' }),
    ];
    renderPage();

    expect(screen.getAllByText('roaming.cdrs.creditAction')).toHaveLength(1);
    expect(screen.getAllByText('roaming.cdrs.reissueAction')).toHaveLength(1);
    expect(screen.getAllByText('roaming.cdrs.pushAction')).toHaveLength(1);
    expect(screen.getByText('roaming.cdrs.superseded')).toBeDefined();
  });

  it('reissues with the reason the operator gives', async () => {
    postMock.mockResolvedValue({ status: 'reissued' });
    rows.value = [cdr({ ocpiCdrId: 'CDR-9', hasCredit: true })];
    renderPage();

    fireEvent.click(screen.getByText('roaming.cdrs.reissueAction'));
    fireEvent.change(screen.getByLabelText('roaming.cdrs.reason'), {
      target: { value: 'Corrected tariff' },
    });
    const confirm = screen.getAllByText('roaming.cdrs.reissueAction').at(-1);
    if (confirm == null) throw new Error('no confirm button');
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/ocpi/cdrs/CDR-9/reissue', {
        reason: 'Corrected tariff',
      });
    });
  });

  it('shows no actions without roaming:write', () => {
    canWrite.value = false;
    rows.value = [cdr({ pushStatus: 'failed' })];
    renderPage();

    expect(screen.queryByText('common.actions')).toBeNull();
    expect(screen.queryByText('roaming.cdrs.pushAction')).toBeNull();
  });
});
