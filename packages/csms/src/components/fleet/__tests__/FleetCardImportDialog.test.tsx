// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const h = vi.hoisted(() => ({ postMock: vi.fn(), fleetUser: false }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'count' in opts ? `${key}:${String(opts['count'])}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', () => ({ api: { post: h.postMock } }));
vi.mock('@/lib/auth', () => ({ useIsFleetUser: () => h.fleetUser }));

import { FleetCardImportDialog } from '../FleetCardImportDialog';

function renderDialog(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FleetCardImportDialog fleetId="flt_1" open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
}

function pickFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input == null) throw new Error('no file input');
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(() => {
  cleanup();
  h.postMock.mockReset();
});

describe('FleetCardImportDialog', () => {
  it('tells a fleet user to leave the member email column empty', () => {
    h.fleetUser = true;
    try {
      renderDialog();
      expect(screen.getByText('fleets.cards.import.columnsFleetUser')).toBeTruthy();
      expect(screen.queryByText('fleets.cards.import.columns')).toBeNull();
    } finally {
      h.fleetUser = false;
    }
  });

  it('sends the CSV text and lists what was added and refused', async () => {
    h.postMock.mockResolvedValue({
      created: 1,
      refused: [{ row: 3, field: 'idToken', reason: 'duplicate' }],
    });
    renderDialog();
    pickFile(new File(['idToken\nCARD-1\nCARD-1\n'], 'cards.csv', { type: 'text/csv' }));
    expect(await screen.findByTestId('fleet-card-import-file')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'fleets.cards.import.submit' }));
    await waitFor(() => {
      expect(h.postMock).toHaveBeenCalledWith('/v1/fleets/flt_1/cards/import', {
        csv: 'idToken\nCARD-1\nCARD-1\n',
      });
    });
    expect(await screen.findByText('fleets.cards.import.created:1')).toBeTruthy();
    expect(screen.getByText('fleets.cards.import.refused:1')).toBeTruthy();
    expect(screen.getByTestId('fleet-card-import-refused').textContent).toContain(
      'fleets.cards.import.refusedRow',
    );
  });

  it('refuses a file over 512 KB and asks for a file before sending', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'fleets.cards.import.submit' }));
    expect(await screen.findByText('fleets.cards.import.chooseFirst')).toBeTruthy();
    pickFile(new File(['x'.repeat(512 * 1024 + 1)], 'big.csv', { type: 'text/csv' }));
    expect(await screen.findByText('fleets.cards.import.tooLarge')).toBeTruthy();
    expect(h.postMock).not.toHaveBeenCalled();
  });
});
