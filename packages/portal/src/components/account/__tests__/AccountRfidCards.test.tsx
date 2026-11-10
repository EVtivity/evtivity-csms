// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, patchMock, postMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: vi.fn(),
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
  return { api: { get: getMock, post: postMock, patch: patchMock }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { AccountRfidCards } from '../AccountRfidCards';
import { ApiError } from '@/lib/api';

function card(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'dtk_1',
    idToken: 'CARD0001',
    tokenType: 'ISO14443',
    isActive: true,
    expiresAt: null,
    blockedByOperator: false,
    ...over,
  };
}

/** Answers the card list and the feature flags (the features call answers `{}` unless given). */
function mockGets(cards: unknown[], features: Record<string, unknown> = {}): void {
  getMock.mockImplementation((url: string) =>
    Promise.resolve(url === '/v1/portal/features' ? features : cards),
  );
}

function renderCards(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccountRfidCards />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
  postMock.mockReset();
  toastMock.mockReset();
});

describe('AccountRfidCards', () => {
  it('locks a card the operator deactivated and says why', async () => {
    mockGets([card({ isActive: false, blockedByOperator: true })]);
    renderCards();

    expect(await screen.findByText('rfid.blockedByOperator')).toBeTruthy();
    const toggle = screen.getByRole('switch');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets the driver turn on a card the driver removed', async () => {
    mockGets([card({ isActive: false, blockedByOperator: false })]);
    renderCards();

    const toggle = await screen.findByRole('switch');
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('rfid.blockedByOperator')).toBeNull();
  });

  it('marks an active card past its expiry as expired', async () => {
    mockGets([card({ expiresAt: '2020-01-01T00:00:00Z' })]);
    renderCards();

    expect(await screen.findByText('rfid.expired')).toBeTruthy();
  });

  it('shows the label above the masked card number', async () => {
    mockGets([card({ label: 'Company card' })]);
    renderCards();

    expect(await screen.findByText('Company card')).toBeTruthy();
    expect(screen.getByText('••••0001 · ISO14443')).toBeTruthy();
  });

  it('renames a card', async () => {
    mockGets([card({ label: 'Company card' })]);
    patchMock.mockResolvedValue(card({ label: 'Private' }));
    renderCards();

    fireEvent.click(await screen.findByRole('button', { name: 'rfid.renameCard' }));
    const input = screen.getByRole('textbox', { name: 'rfid.label' });
    expect((input as HTMLInputElement).value).toBe('Company card');
    fireEvent.change(input, { target: { value: ' Private ' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/portal/tokens/dtk_1', { label: 'Private' });
    });
  });

  it('clears a label renamed to empty', async () => {
    mockGets([card({ label: 'Company card' })]);
    patchMock.mockResolvedValue(card({ label: null }));
    renderCards();

    fireEvent.click(await screen.findByRole('button', { name: 'rfid.renameCard' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'rfid.label' }), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/v1/portal/tokens/dtk_1', { label: null });
    });
  });

  describe('while the operator manages the cards', () => {
    const off = { rfidSelfServiceEnabled: false };

    it('shows the cards read-only with the note, and no add, rename or activation control', async () => {
      mockGets([card({ label: 'Company card' }), card({ id: 'dtk_2', isActive: false })], off);
      renderCards();

      expect(await screen.findByText('rfid.managedByOperator')).toBeTruthy();
      expect(screen.getByText('Company card')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'rfid.addCard' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'rfid.renameCard' })).toBeNull();
      expect(screen.queryByRole('switch')).toBeNull();
      expect(screen.queryByRole('link', { name: 'rfid.contactSupport' })).toBeNull();
    });

    it('links to support when support cases are on', async () => {
      mockGets([card({})], { ...off, supportEnabled: true });
      renderCards();

      const link = await screen.findByRole('link', { name: 'rfid.contactSupport' });
      expect(link.getAttribute('href')).toBe('/support');
    });

    it('says no cards are assigned when the list is empty', async () => {
      mockGets([], off);
      renderCards();

      expect(await screen.findByText('rfid.noCardsAssigned')).toBeTruthy();
      expect(screen.queryByText('rfid.noCards')).toBeNull();
    });

    it('keeps every control while the flag is missing', async () => {
      mockGets([card({})], {});
      renderCards();

      expect(await screen.findByRole('switch')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'rfid.renameCard' })).toBeTruthy();
      expect(screen.queryByText('rfid.managedByOperator')).toBeNull();
    });

    it('reloads the cards and the features when a stale screen is refused', async () => {
      mockGets([card({ label: 'Company card' })], {});
      patchMock.mockRejectedValue(
        new ApiError(403, { error: 'refused', code: 'RFID_SELF_SERVICE_DISABLED' }),
      );
      const client = renderCards();
      const invalidate = vi.spyOn(client, 'invalidateQueries');

      fireEvent.click(await screen.findByRole('button', { name: 'rfid.renameCard' }));
      fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

      await waitFor(() => {
        expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['portal-features'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['portal-tokens'] });
    });
  });
});
