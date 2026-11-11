// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.hoisted(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { TOKENS_COLUMNS, TokensTable, type Token } from '@/components/TokensTable';
import { buildDefaultVisibility } from '@/lib/column-visibility';

const TOKENS: Token[] = [
  {
    id: 'tok_internal_1',
    driverId: 'drv_1',
    driverFirstName: 'Ada',
    driverLastName: 'Lovelace',
    idToken: 'RFID-0001',
    tokenType: 'ISO14443',
    label: 'Blue fob',
    isActive: true,
    expiresAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
  {
    id: 'tok_internal_2',
    driverId: null,
    idToken: 'RFID-0002',
    tokenType: 'ISO14443',
    label: null,
    isActive: true,
    expiresAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
  },
];

function renderTable(): void {
  render(
    <MemoryRouter>
      <TokensTable
        tokens={TOKENS}
        page={1}
        totalPages={1}
        onPageChange={() => undefined}
        timezone="UTC"
        visibility={buildDefaultVisibility(TOKENS_COLUMNS, false)}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('TokensTable', () => {
  it('has a Label column after the RFID card value, shown by default on desktop and phones', () => {
    const keys = TOKENS_COLUMNS.map((c) => c.key);
    expect(keys.indexOf('label')).toBe(keys.indexOf('token') + 1);
    expect(keys).not.toContain('tokenId');
    expect(buildDefaultVisibility(TOKENS_COLUMNS, false)['label']).toBe(true);
    expect(buildDefaultVisibility(TOKENS_COLUMNS, true)['label']).toBe(true);
  });

  it('shows the label in its own cell, empty for a card without one, and no internal id', () => {
    renderTable();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 2)).toEqual(['tokens.token', 'tokens.label']);
    const first = screen.getByTestId('token-row-tok_internal_1');
    expect(within(first).getByTestId('token-label-cell').textContent).toBe('Blue fob');
    const second = screen.getByTestId('token-row-tok_internal_2');
    expect(within(second).getByTestId('token-label-cell').textContent).toBe('');
    expect(document.body.textContent).not.toContain('tok_internal_1');
  });
});
