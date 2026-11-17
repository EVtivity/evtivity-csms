// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({ get: vi.fn(), canWrite: false }));

vi.mock('@/lib/auth', () => ({
  useHasPermission: (p: string) => (p === 'fleetCards:write' ? h.canWrite : true),
  useIsFleetUser: () => true,
  useHasAllSiteAccess: () => false,
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars == null ? key : `${key} ${Object.values(vars).join('|')}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => `at ${value}`,
}));
vi.mock('@/lib/api', () => ({
  api: { get: h.get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/components/saved-message', () => ({ useSavedToast: () => vi.fn() }));

import { FleetCardsTab } from '../FleetCardsTab';
import {
  historyActorText,
  historyChangeLines,
  type FleetCardHistoryEntry,
} from '../FleetCardHistoryDialog';

const t = ((key: string, vars?: Record<string, string>) =>
  vars == null ? key : `${key} ${Object.values(vars).join('|')}`) as never;

function entry(over: Partial<FleetCardHistoryEntry>): FleetCardHistoryEntry {
  return {
    id: 1,
    createdAt: '2026-11-17T10:00:00Z',
    changes: ['given'],
    reason: null,
    memberBefore: null,
    memberAfter: { id: 'drv_1', name: 'Ana Lee', erased: false },
    labelBefore: null,
    labelAfter: null,
    actor: { kind: 'operator', name: null, viaApiKey: false },
    ...over,
  };
}

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.canWrite = false;
});

describe('fleet card history', () => {
  it('names the member, the label change and an erased member without a name', () => {
    expect(historyChangeLines(entry({}), t)).toEqual(['fleets.cards.history.change.given Ana Lee']);
    expect(
      historyChangeLines(
        entry({
          changes: ['taken_back', 'renamed'],
          memberBefore: { id: 'drv_2', name: null, erased: true },
          labelBefore: 'Van 1',
          labelAfter: null,
        }),
        t,
      ),
    ).toEqual([
      'fleets.cards.history.change.taken_back drivers.erasedName',
      'fleets.cards.history.change.renamed Van 1|fleets.cards.history.noLabel',
    ]);
  });

  it('shows an unnamed operator by kind and a named person through an API key', () => {
    expect(historyActorText(entry({}), t)).toBe('fleets.cards.history.actor.operator');
    expect(
      historyActorText(
        entry({ actor: { kind: 'fleet_user', name: 'Fay Fleet', viaApiKey: true } }),
        t,
      ),
    ).toBe('fleets.cards.history.viaApiKey Fay Fleet');
  });

  it('opens the history from the card list for a reader without write access', async () => {
    h.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('/history')
          ? {
              data: [
                entry({ id: 2, changes: ['turned_off'], memberAfter: null, reason: null }),
                entry({ id: 1, changes: ['added', 'given'] }),
              ],
              total: 2,
            }
          : {
              data: [
                {
                  id: 'dtk_1',
                  idToken: 'CARD-0001',
                  tokenType: 'ISO14443',
                  label: 'Van 12',
                  isActive: true,
                  status: 'active',
                  blockedByOperator: false,
                  driver: null,
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-01T00:00:00Z',
                },
              ],
              total: 1,
            },
      ),
    );
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <FleetCardsTab fleetId="flt_1" />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: 'fleets.cards.editCard' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'fleets.cards.history.open' }));
    const dialog = await screen.findByRole('dialog');
    const list = await within(dialog).findByTestId('fleet-card-history');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('fleets.cards.history.change.turned_off')).toBeTruthy();
    expect(within(list).getByText('fleets.cards.history.change.given Ana Lee')).toBeTruthy();
    expect(h.get).toHaveBeenCalledWith('/v1/fleets/flt_1/cards/dtk_1/history?page=1&limit=10');
  });
});
