// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => {
  // The auth store reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  return { apiMock: { get: vi.fn(), post: vi.fn() } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

import { StationCommands } from '../StationCommands';
import { OcppLogTable } from '../OcppLogTable';
import type { OcppLogEntry } from '../OcppLogTable';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderCommands(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StationCommands stationId="CS-1" ocppProtocol="ocpp2.1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function sendClearCache(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'commands.clearCache' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.send' }));
  // Clear Cache asks for a confirmation first.
  const confirms = await screen.findAllByRole('dialog');
  const confirm = confirms.at(-1) as HTMLElement;
  fireEvent.click(within(confirm).getByRole('button', { name: 'common.send' }));
  return dialog;
}

describe('quick command to an offline station (ISSUES item 19)', () => {
  it('shows Queued and hides Send, so the queued command is not sent twice', async () => {
    apiMock.post.mockResolvedValue({
      status: 'queued',
      code: 'COMMAND_QUEUED',
      stationId: 'CS-1',
      action: 'ClearCache',
      message: 'Station offline, command queued',
    });
    renderCommands();
    const dialog = await sendClearCache();
    expect(await within(dialog).findByText('commands.queued')).toBeTruthy();
    expect(apiMock.post).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByRole('button', { name: 'common.send' })).toBeNull();
    expect(within(dialog).getAllByRole('button', { name: 'common.close' }).length).toBeGreaterThan(
      0,
    );
  });

  it('keeps Send after a command the station answered', async () => {
    apiMock.post.mockResolvedValue({ status: 'Accepted' });
    renderCommands();
    const dialog = await sendClearCache();
    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledTimes(1);
    });
    expect(await within(dialog).findByText('commands.response')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'common.send' })).toBeTruthy();
  });
});

const BASE: Omit<OcppLogEntry, 'id' | 'processingStatus' | 'messageId'> = {
  direction: 'outbound',
  messageType: 2,
  action: 'ClearCache',
  payload: {},
  errorCode: null,
  errorDescription: null,
  createdAt: '2026-10-12T10:00:00Z',
};

function renderLog(entries: OcppLogEntry[], showProcessingStatusColumn: boolean): void {
  render(
    <OcppLogTable
      title="log"
      entries={entries}
      page={1}
      totalPages={1}
      onPageChange={() => {}}
      timezone="UTC"
      emptyMessage="empty"
      rowTestIdPrefix="ocpp-message-row"
      showProcessingStatusColumn={showProcessingStatusColumn}
    />,
  );
}

describe('OCPP message log status (ISSUES item 18)', () => {
  const entries: OcppLogEntry[] = [
    { ...BASE, id: 7, messageId: 'cmd-1', processingStatus: 'queued' },
    { ...BASE, id: 7, messageId: 'msg-1', processingStatus: 'processed' },
  ];

  it('shows the message type under Type and Processed or Queued under Status', () => {
    renderLog(entries, true);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      'common.timestamp',
      'reservations.direction',
      'reservations.action',
      'common.type',
      'common.status',
    ]);
    const queued = screen.getByTestId('ocpp-message-row-queued-7');
    expect(within(queued).getByText('CALL')).toBeTruthy();
    expect(within(queued).getByText('ocppLogs.queued')).toBeTruthy();
    const processed = screen.getByTestId('ocpp-message-row-7');
    expect(within(processed).getByText('ocppLogs.processed')).toBeTruthy();
  });

  it('expands one row when a queue row and a log row share an id', () => {
    renderLog(entries, true);
    fireEvent.click(screen.getByTestId('ocpp-message-row-queued-7'));
    expect(screen.getByText('Message ID: cmd-1')).toBeTruthy();
    expect(screen.queryByText('Message ID: msg-1')).toBeNull();
  });

  it('has no Status column in a log without processing states (reservation commands)', () => {
    renderLog([{ ...BASE, id: 1, messageId: 'msg-1' }], false);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain('common.type');
    expect(headers).not.toContain('common.status');
  });
});
