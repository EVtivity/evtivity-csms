// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { patchMock, toastMock } = vi.hoisted(() => ({ patchMock: vi.fn(), toastMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { roles?: string }) =>
      options?.roles != null ? `${key}:${options.roles}` : key,
  }),
}));
vi.mock('@/lib/api', () => ({ api: { patch: patchMock } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { PartnerRolesCard } from '../PartnerRolesCard';

afterEach(() => {
  cleanup();
  patchMock.mockReset();
  toastMock.mockReset();
});

function renderCard(props: Partial<Parameters<typeof PartnerRolesCard>[0]> = {}) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <PartnerRolesCard
        partnerId="ocp_1"
        declaredRoles={[{ role: 'CPO' }, { role: 'HUB' }]}
        approvedRoles={['CPO']}
        rolesApprovedAt="2026-10-23T00:00:00.000Z"
        canWrite
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('PartnerRolesCard', () => {
  it('shows the declared roles, the approved ones checked, and the roles held back', () => {
    renderCard();
    expect(screen.getByText('roaming.partners.declaredRoles:CPO, HUB')).toBeTruthy();
    expect(screen.getByText('roaming.partners.heldRoles:HUB')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('CPO').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('HUB').checked).toBe(false);
  });

  it('saves the selected roles and stays disabled until something changed', async () => {
    patchMock.mockResolvedValue({});
    renderCard();
    const save = screen.getByRole('button', { name: 'common.save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('HUB'));
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/ocpi/partners/ocp_1', {
        approvedRoles: ['CPO', 'HUB'],
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({ title: 'roaming.partners.approvedRolesSaved' });
    });
  });

  it('is read only without roaming write', () => {
    renderCard({ canWrite: false });
    expect(screen.getByLabelText<HTMLInputElement>('CPO').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'common.save' })).toBeNull();
  });

  it('says when the roles are not decided yet and nothing was declared', () => {
    renderCard({ declaredRoles: [], approvedRoles: [], rolesApprovedAt: null });
    expect(screen.getByText('roaming.partners.rolesNotDecided')).toBeTruthy();
    expect(screen.getByText('roaming.partners.noDeclaredRoles')).toBeTruthy();
  });

  it('flags the declared roles of a new partner that waits for approval', () => {
    renderCard({ declaredRoles: ['CPO'], approvedRoles: [], rolesApprovedAt: null });
    expect(screen.getByText('roaming.partners.rolesNotDecided')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('roaming.partners.heldRoles:CPO');
  });
});
