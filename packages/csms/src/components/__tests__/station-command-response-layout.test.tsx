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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LONG_RESPONSE = {
  status: 'Rejected',
  statusInfo: { reasonCode: 'X'.repeat(300), additionalInfo: 'unbroken'.repeat(50) },
};

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

function expectBoundedResponse(dialog: HTMLElement, bodyTestId: string, blockTestId: string): void {
  // The dialog body is a grid child: min-w-0 lets it shrink to the dialog width on phones.
  expect(within(dialog).getByTestId(bodyTestId).className).toContain('min-w-0');
  // The wrapper never widens its parent, and the shared CodeBlock scrolls both ways inside it.
  const block = within(dialog).getByTestId(blockTestId);
  expect(block.className).toContain('w-0');
  expect(block.className).toContain('min-w-full');
  const pre = block.querySelector('pre');
  expect(pre?.className).toContain('overflow-auto');
  expect(pre?.className).toContain('max-h-80');
  expect(pre?.textContent).toContain('X'.repeat(300));
  expect(within(block).getByRole('button', { name: 'ai.copyCode' })).toBeTruthy();
}

describe('command response JSON stays inside the dialog', () => {
  it('quick command response scrolls inside a bounded CodeBlock', async () => {
    apiMock.post.mockResolvedValue(LONG_RESPONSE);
    renderCommands();
    fireEvent.click(screen.getByRole('button', { name: 'commands.clearCache' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.send' }));
    // Clear Cache asks for a confirmation first.
    const confirms = await screen.findAllByRole('dialog');
    const confirm = confirms.at(-1) as HTMLElement;
    fireEvent.click(within(confirm).getByRole('button', { name: 'common.send' }));
    await within(dialog).findByTestId('quick-command-response');
    expectBoundedResponse(dialog, 'quick-command-body', 'quick-command-response');
  });

  it('advanced command response scrolls inside a bounded CodeBlock', async () => {
    // No schema: the payload falls back to the raw JSON textarea.
    apiMock.get.mockRejectedValue(new Error('no schema'));
    apiMock.post.mockResolvedValue(LONG_RESPONSE);
    renderCommands();
    fireEvent.change(screen.getByLabelText('commands.action'), {
      target: { value: 'ClearCache' },
    });
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.send' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByTestId('advanced-command-response');
    expectBoundedResponse(dialog, 'advanced-command-body', 'advanced-command-response');
  });
});
