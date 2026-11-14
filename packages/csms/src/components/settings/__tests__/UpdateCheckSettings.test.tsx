// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn() },
  toastMock: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));

import { UpdateCheckSettings } from '../UpdateCheckSettings';

function setup(settings: Record<string, unknown> | undefined, canWrite = true): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UpdateCheckSettings settings={settings} canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

function toggle(): HTMLElement {
  return screen.getByRole('switch', { name: 'settings.updateCheck.enabled' });
}

beforeEach(() => {
  apiMock.put.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Update Check settings', () => {
  it('reads a missing setting as on and a stored false as off', () => {
    setup({});
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    cleanup();
    setup({ 'system.updateCheckEnabled': false });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('asks before turning it off, then saves false', async () => {
    setup({ 'system.updateCheckEnabled': true });
    fireEvent.click(toggle());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('confirm-toggle-off-effect').textContent).toBe(
      'settings.updateCheck.offEffect',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.toggleOff.confirm' }));
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/system.updateCheckEnabled', {
        value: false,
      });
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith({ variant: 'success', title: 'common.saved' });
    });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('puts the switch back and says why when the save fails', async () => {
    apiMock.put.mockRejectedValue(new Error('offline'));
    setup({ 'system.updateCheckEnabled': false });
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
    });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('shows the switch read-only without settings.system:write', () => {
    setup({ 'system.updateCheckEnabled': true }, false);
    expect(toggle().hasAttribute('disabled')).toBe(true);
    fireEvent.click(toggle());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiMock.put).not.toHaveBeenCalled();
  });
});
