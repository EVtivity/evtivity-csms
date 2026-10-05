// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';

const { getMock, postMock, patchMock, canWrite } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  canWrite: { value: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, patch: patchMock, delete: vi.fn() },
  getApiErrorFieldDetails: () => ({}),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: () => canWrite.value,
  useAuth: (selector: (s: { user: null }) => unknown) => selector({ user: null }),
}));
vi.mock('@/hooks/use-paginated-query', () => ({
  usePaginatedQuery: () => ({ data: [], page: 1, totalPages: 1, setPage: vi.fn() }),
}));
vi.mock('@/components/EntityHistoryTab', () => ({ EntityHistoryTab: () => null }));
vi.mock('@/components/entity-nav-buttons', () => ({ EntityNavButtons: () => null }));

import { RoamingPartnerCreate } from '../RoamingPartnerCreate';
import { RoamingPartnerDetail } from '../RoamingPartnerDetail';

function renderAt(path: string, element: React.JSX.Element, route: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const PARTNER = {
  id: 'opr_000000000001',
  name: 'Peer',
  countryCode: 'NL',
  partyId: 'SIM',
  status: 'pending',
  version: '2.2.1',
  versionUrl: 'http://ocpi-simulator:7105/ocpi/versions',
  allowPrivateNetwork: false,
  roles: [],
  ourRoles: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  endpoints: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  canWrite.value = true;
});

describe('Roaming partner private network flag', () => {
  it('create sends allowPrivateNetwork, off unless checked', async () => {
    postMock.mockResolvedValue({ partner: { id: 'opr_1' }, registrationToken: 'tok' });
    renderAt('/new', <RoamingPartnerCreate />, '/new');

    fireEvent.change(screen.getByLabelText('common.name'), { target: { value: 'Peer' } });
    fireEvent.change(screen.getByLabelText('roaming.partners.countryCode'), {
      target: { value: 'NL' },
    });
    fireEvent.change(screen.getByLabelText('roaming.partners.partyIdLabel'), {
      target: { value: 'SIM' },
    });
    fireEvent.click(screen.getByLabelText('roaming.partners.allowPrivateNetwork'));
    fireEvent.click(screen.getByText('common.create'));

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/v1/ocpi/partners',
        expect.objectContaining({ allowPrivateNetwork: true }),
      );
    });
  });

  it('detail toggles the flag through PATCH', async () => {
    getMock.mockResolvedValue(PARTNER);
    patchMock.mockResolvedValue({ ...PARTNER, allowPrivateNetwork: true });
    renderAt('/partners/opr_000000000001', <RoamingPartnerDetail />, '/partners/:id');

    const checkbox = await screen.findByLabelText('roaming.partners.allowPrivateNetwork');
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/ocpi/partners/opr_000000000001', {
        allowPrivateNetwork: true,
      });
    });
  });

  it('detail disables the flag without roaming:write', async () => {
    canWrite.value = false;
    getMock.mockResolvedValue(PARTNER);
    renderAt('/partners/opr_000000000001', <RoamingPartnerDetail />, '/partners/:id');

    const checkbox = await screen.findByLabelText('roaming.partners.allowPrivateNetwork');
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
  });
});
