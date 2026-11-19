// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  canWrite: true,
  fleetUser: true,
  allSites: true,
}));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => (p === 'fleetCards:write' ? h.canWrite : true),
  useIsFleetUser: () => h.fleetUser,
  useHasAllSiteAccess: () => h.allSites,
}));
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
  return { api: { get: h.get, post: h.post, patch: h.patch, delete: h.del }, ApiError };
});
vi.mock('@/components/saved-message', () => ({ useSavedToast: () => vi.fn() }));

import { FleetCardsTab, fleetCardActiveLock, type FleetCard } from '../FleetCardsTab';
import { ApiError } from '@/lib/api';

function card(over: Partial<FleetCard>): FleetCard {
  return {
    id: 'dtk_1',
    idToken: 'CARD-0001',
    tokenType: 'ISO14443',
    label: 'Van 12',
    isActive: true,
    status: 'active',
    blockedByOperator: false,
    driver: null,
    monthlyLimitCents: null,
    monthSpentCents: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function mockGets(cards: FleetCard[]): void {
  // The member search asks the API for active members matching the text.
  h.get.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('/drivers')
        ? {
            data: [{ id: 'drv_1', firstName: 'Ana', lastName: 'Lee', isActive: true }],
            total: 1,
          }
        : { data: cards, total: cards.length },
    ),
  );
}

function renderTab(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FleetCardsTab fleetId="flt_1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
  h.del.mockReset();
  h.canWrite = true;
  h.fleetUser = true;
  h.allSites = true;
});

describe('FleetCardsTab', () => {
  it('lists the value, type, label, member and status of each card', async () => {
    h.fleetUser = false;
    mockGets([
      card({ driver: { id: 'drv_1', firstName: 'Ana', lastName: 'Lee' } }),
      card({
        id: 'dtk_2',
        idToken: 'CARD-0002',
        label: null,
        status: 'deactivated',
        isActive: false,
      }),
    ]);
    renderTab();
    const row = await screen.findByTestId('fleet-card-row-dtk_1');
    expect(within(row).getByText('CARD-0001')).toBeTruthy();
    expect(within(row).getByText('ISO14443')).toBeTruthy();
    expect(within(row).getByText('Van 12')).toBeTruthy();
    expect(within(row).getByText('Ana Lee')).toBeTruthy();
    expect(within(row).getByText('fleets.cards.status.active')).toBeTruthy();
    const other = screen.getByTestId('fleet-card-row-dtk_2');
    expect(within(other).getByText('fleets.cards.noMember')).toBeTruthy();
    expect(within(other).getByText('fleets.cards.status.deactivated')).toBeTruthy();
    // A deactivated card cannot be deactivated again.
    expect(within(other).queryByRole('button', { name: 'fleets.cards.deactivate' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'fleets.cards.deactivate' })).toBeTruthy();
  });

  it('offers a fleet user no deactivation: it turns a card off in the edit dialog', async () => {
    mockGets([card({})]);
    renderTab();
    const row = await screen.findByTestId('fleet-card-row-dtk_1');
    expect(within(row).getByRole('button', { name: 'fleets.cards.editCard' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'fleets.cards.deactivate' })).toBeNull();
  });

  it('hides every action without fleetCards:write', async () => {
    h.canWrite = false;
    mockGets([card({})]);
    renderTab();
    await screen.findByTestId('fleet-card-row-dtk_1');
    expect(screen.queryByRole('button', { name: 'fleets.cards.addCard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'fleets.cards.editCard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'fleets.cards.deactivate' })).toBeNull();
  });

  it('hides every action for a site-restricted operator, whom the API refuses card writes', async () => {
    h.fleetUser = false;
    h.allSites = false;
    mockGets([card({})]);
    renderTab();
    await screen.findByTestId('fleet-card-row-dtk_1');
    expect(screen.queryByRole('button', { name: 'fleets.cards.addCard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'fleets.cards.editCard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'fleets.cards.deactivate' })).toBeNull();
  });

  it('guides a fleet without cards to add or import them, with the actions in the empty list only', async () => {
    mockGets([]);
    renderTab();
    const empty = await screen.findByTestId('empty-state');
    expect(within(empty).getByText('fleets.cards.empty.title')).toBeTruthy();
    expect(within(empty).getByText('fleets.cards.empty.description')).toBeTruthy();
    expect(within(empty).getByRole('button', { name: 'fleets.cards.addCard' })).toBeTruthy();
    expect(within(empty).getByRole('button', { name: 'fleets.cards.import.open' })).toBeTruthy();
    // One add action on screen: the header keeps none while the list is empty.
    expect(screen.getAllByRole('button', { name: 'fleets.cards.addCard' })).toHaveLength(1);
    // Not inside the wide table, which would center the text off a phone screen.
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(within(empty).getByRole('button', { name: 'fleets.cards.import.open' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('shows a reader without fleetCards:write the empty list without actions', async () => {
    h.canWrite = false;
    mockGets([]);
    renderTab();
    const empty = await screen.findByTestId('empty-state');
    expect(within(empty).getByText('fleets.cards.empty.readOnly')).toBeTruthy();
    expect(within(empty).queryByRole('button')).toBeNull();
  });

  it('adds a card given to an active member found by the member search', async () => {
    mockGets([]);
    h.post.mockResolvedValue(card({}));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.addCard' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('fleets.cards.value'), {
      target: { value: ' CARD-0009 ' },
    });
    fireEvent.change(within(dialog).getByLabelText('tokens.label'), {
      target: { value: 'Van 9' },
    });
    const member = within(dialog).getByLabelText('fleets.cards.member');
    fireEvent.change(member, { target: { value: 'Ana' } });
    const option = await within(dialog).findByRole(
      'option',
      { name: 'Ana Lee' },
      { timeout: 2000 },
    );
    const searched = h.get.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/drivers'));
    expect(searched).toContain('/v1/fleets/flt_1/drivers?');
    expect(searched).toContain('search=Ana');
    expect(searched).toContain('active=true');
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.cards.addCard' }));
    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/v1/fleets/flt_1/cards', {
        idToken: 'CARD-0009',
        tokenType: 'ISO14443',
        label: 'Van 9',
        driverId: 'drv_1',
      });
    });
  });

  it('requires a card value before sending', async () => {
    mockGets([]);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.addCard' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.cards.addCard' }));
    expect(await within(dialog).findByText('validation.required')).toBeTruthy();
    expect(h.post).not.toHaveBeenCalled();
  });

  it('shows the API error of a refused add', async () => {
    mockGets([]);
    h.post.mockRejectedValue(
      new ApiError(400, { error: 'Not a member', code: 'FLEET_CARD_DRIVER_NOT_MEMBER' }),
    );
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.addCard' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('fleets.cards.value'), {
      target: { value: 'CARD-1' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.cards.addCard' }));
    // The test t returns keys, so the helper falls back to the API message.
    expect(await within(dialog).findByText('Not a member')).toBeTruthy();
  });

  it('sends only the changed fields of an edit', async () => {
    mockGets([card({})]);
    h.patch.mockResolvedValue(card({}));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.editCard' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('tokens.label'), {
      target: { value: 'Van 13' },
    });
    fireEvent.click(within(dialog).getByLabelText('fleets.cards.active'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(h.patch).toHaveBeenCalledWith('/v1/fleets/flt_1/cards/dtk_1', {
        label: 'Van 13',
        isActive: false,
      });
    });
  });

  it('offers a fleet user only the two plain card types, ISO14443 first', async () => {
    mockGets([card({})]);
    h.post.mockResolvedValue(card({ id: 'dtk_9', tokenType: 'ISO15693' }));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.addCard' }));
    const dialog = await screen.findByRole('dialog');
    const type = within(dialog).getByLabelText<HTMLSelectElement>('tokens.type');
    expect([...type.options].map((o) => [o.value, o.textContent])).toEqual([
      ['ISO14443', 'fleets.cards.types.ISO14443'],
      ['ISO15693', 'fleets.cards.types.ISO15693'],
    ]);
    expect(type.value).toBe('ISO14443');
    fireEvent.change(within(dialog).getByLabelText('fleets.cards.value'), {
      target: { value: 'CARD-0009' },
    });
    fireEvent.change(type, { target: { value: 'ISO15693' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.cards.addCard' }));
    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/v1/fleets/flt_1/cards', {
        idToken: 'CARD-0009',
        tokenType: 'ISO15693',
      });
    });
  });

  it('offers an operator every card type, each with its hint', async () => {
    h.fleetUser = false;
    mockGets([card({})]);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.addCard' }));
    const dialog = await screen.findByRole('dialog');
    const type = within(dialog).getByLabelText<HTMLSelectElement>('tokens.type');
    expect([...type.options].map((o) => o.textContent)).toEqual([
      'eMAID - fleets.cards.typeHints.eMAID',
      'ISO14443 - fleets.cards.typeHints.ISO14443',
      'ISO15693 - fleets.cards.typeHints.ISO15693',
      'KeyCode - fleets.cards.typeHints.KeyCode',
      'Local - fleets.cards.typeHints.Local',
    ]);
  });

  it('shows a fleet user the type of a card read-only, in plain words or as stored', async () => {
    mockGets([card({}), card({ id: 'dtk_2', idToken: 'CARD-0002', tokenType: 'KeyCode' })]);
    renderTab();
    const plain = await screen.findByTestId('fleet-card-row-dtk_1');
    expect(within(plain).getByText('fleets.cards.types.ISO14443')).toBeTruthy();
    const other = screen.getByTestId('fleet-card-row-dtk_2');
    expect(within(other).getByText('KeyCode')).toBeTruthy();
    fireEvent.click(within(other).getByRole('button', { name: 'fleets.cards.editCard' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('fleet-card-edit-type').textContent).toBe('KeyCode');
    expect(within(dialog).queryByLabelText('tokens.type')).toBeNull();
  });

  it('locks the active checkbox of a card an operator turned off, for a fleet user', async () => {
    mockGets([card({ isActive: false, status: 'suspended', blockedByOperator: true })]);
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.editCard' }));
    const dialog = await screen.findByRole('dialog');
    const active = within(dialog).getByLabelText<HTMLInputElement>('fleets.cards.active');
    expect(active.disabled).toBe(true);
    expect(within(dialog).getByText('fleets.cards.lockedByOperator')).toBeTruthy();
  });

  it('lets an operator deactivate a card after the confirmation', async () => {
    h.fleetUser = false;
    mockGets([card({})]);
    h.del.mockResolvedValue(card({ status: 'deactivated', isActive: false }));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.deactivate' }));
    const dialog = await screen.findByRole('dialog', { name: 'fleets.cards.deactivateTitle' });
    expect(h.del).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'fleets.cards.deactivate' }));
    await waitFor(() => {
      expect(h.del).toHaveBeenCalledWith('/v1/fleets/flt_1/cards/dtk_1');
    });
  });
});

describe('fleetCardActiveLock', () => {
  it('locks a deactivated card for everyone and an operator block for fleet users only', () => {
    expect(fleetCardActiveLock({ status: 'deactivated', blockedByOperator: false }, false)).toBe(
      'deactivated',
    );
    expect(fleetCardActiveLock({ status: 'suspended', blockedByOperator: true }, true)).toBe(
      'blockedByOperator',
    );
    expect(fleetCardActiveLock({ status: 'suspended', blockedByOperator: true }, false)).toBeNull();
    expect(fleetCardActiveLock({ status: 'active', blockedByOperator: false }, true)).toBeNull();
  });

  it('shows this month against the limit and sends a changed limit in cents', async () => {
    mockGets([card({ monthlyLimitCents: 10_000, monthSpentCents: 2_500 })]);
    h.patch.mockResolvedValue(card({}));
    renderTab();
    const row = await screen.findByTestId('fleet-card-row-dtk_1');
    expect(within(row).getByText('fleets.cards.monthlyLimit.spentOfLimit')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'fleets.cards.editCard' }));
    const dialog = await screen.findByRole('dialog');
    const limit = within(dialog).getByLabelText<HTMLInputElement>(
      /fleets.cards.monthlyLimit.label/,
    );
    expect(limit.value).toBe('100.00');
    fireEvent.change(limit, { target: { value: '250.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(h.patch).toHaveBeenCalledWith('/v1/fleets/flt_1/cards/dtk_1', {
        monthlyLimitCents: 25_050,
      });
    });
  });

  it('removes the limit when the field is emptied and refuses an amount out of range', async () => {
    mockGets([card({ monthlyLimitCents: 10_000 })]);
    h.patch.mockResolvedValue(card({}));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.editCard' }));
    const dialog = await screen.findByRole('dialog');
    const limit = within(dialog).getByLabelText(/fleets.cards.monthlyLimit.label/);
    fireEvent.change(limit, { target: { value: '0' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));
    expect(await within(dialog).findByText('fleets.cards.monthlyLimit.invalid')).toBeTruthy();
    expect(h.patch).not.toHaveBeenCalled();
    fireEvent.change(limit, { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }));
    await waitFor(() => {
      expect(h.patch).toHaveBeenCalledWith('/v1/fleets/flt_1/cards/dtk_1', {
        monthlyLimitCents: null,
      });
    });
  });

  it('shows what a card without a limit spent this month', async () => {
    mockGets([card({ monthSpentCents: 1_234 })]);
    renderTab();
    const row = await screen.findByTestId('fleet-card-row-dtk_1');
    expect(within(row).getByText('fleets.cards.monthlyLimit.none')).toBeTruthy();
  });

  it('shows only the limit when the reader may not see the spend', async () => {
    mockGets([
      card({ id: 'dtk_1', monthlyLimitCents: 10_000, monthSpentCents: null }),
      card({ id: 'dtk_2', idToken: 'CARD-2', monthSpentCents: null }),
    ]);
    renderTab();
    const limited = await screen.findByTestId('fleet-card-row-dtk_1');
    expect(within(limited).queryByText('fleets.cards.monthlyLimit.spentOfLimit')).toBeNull();
    expect(within(limited).getByText('$100.00')).toBeTruthy();
    const open = screen.getByTestId('fleet-card-row-dtk_2');
    expect(within(open).getByText('common.na')).toBeTruthy();
  });
});
