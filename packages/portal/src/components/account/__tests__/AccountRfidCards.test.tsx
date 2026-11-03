// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, patchMock } = vi.hoisted(() => ({ getMock: vi.fn(), patchMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: vi.fn(), patch: patchMock }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { AccountRfidCards } from '../AccountRfidCards';

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

function renderCards(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountRfidCards />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  patchMock.mockReset();
});

describe('AccountRfidCards', () => {
  it('locks a card the operator deactivated and says why', async () => {
    getMock.mockResolvedValue([card({ isActive: false, blockedByOperator: true })]);
    renderCards();

    expect(await screen.findByText('rfid.blockedByOperator')).toBeTruthy();
    const toggle = screen.getByRole('switch');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets the driver turn on a card the driver removed', async () => {
    getMock.mockResolvedValue([card({ isActive: false, blockedByOperator: false })]);
    renderCards();

    const toggle = await screen.findByRole('switch');
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('rfid.blockedByOperator')).toBeNull();
  });

  it('marks an active card past its expiry as expired', async () => {
    getMock.mockResolvedValue([card({ expiresAt: '2020-01-01T00:00:00Z' })]);
    renderCards();

    expect(await screen.findByText('rfid.expired')).toBeTruthy();
  });

  it('shows the label above the masked card number', async () => {
    getMock.mockResolvedValue([card({ label: 'Company card' })]);
    renderCards();

    expect(await screen.findByText('Company card')).toBeTruthy();
    expect(screen.getByText('••••0001 · ISO14443')).toBeTruthy();
  });

  it('renames a card', async () => {
    getMock.mockResolvedValue([card({ label: 'Company card' })]);
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
    getMock.mockResolvedValue([card({ label: 'Company card' })]);
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
});
