// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: getMock, post: postMock, delete: deleteMock },
}));

import { WebhookSigningSecret } from '../settings/WebhookSigningSecret';

const PATH = '/v1/settings/notifications/webhook-signing-secret';

function renderIt(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <WebhookSigningSecret />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WebhookSigningSecret', () => {
  it('generates a secret and shows it once', async () => {
    getMock.mockResolvedValue({ configured: false });
    postMock.mockResolvedValue({ secret: 'whsec_abc' });
    renderIt();
    expect(await screen.findByText('settings.webhookSigningSecretNotConfigured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.webhookSigningSecretGenerate' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(PATH, {});
    });
    expect((await screen.findByTestId('webhook-signing-secret')).textContent).toBe('whsec_abc');
  });

  it('asks before replacing a stored secret', async () => {
    getMock.mockResolvedValue({ configured: true });
    postMock.mockResolvedValue({ secret: 'whsec_new' });
    renderIt();
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.webhookSigningSecretRegenerate' }),
    );
    expect(postMock).not.toHaveBeenCalled();
    expect(await screen.findByText('settings.webhookSigningSecretRegenerateConfirm')).toBeTruthy();
  });
});
