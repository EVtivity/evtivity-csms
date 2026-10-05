// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({}), put: putMock, post: vi.fn() },
  getApiErrorFieldDetails: () => ({}),
}));

import { NotificationSettings } from '../settings/NotificationSettings';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotificationSettings webhooks tab', () => {
  it('shows the stored allowlist and saves the edited hosts as an array', async () => {
    putMock.mockResolvedValue({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings?sub=webhooks']}>
          <NotificationSettings
            settings={{ 'notifications.webhookAllowedPrivateHosts': ['n8n', '10.0.0.7'] }}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const textarea = await screen.findByLabelText('settings.webhookAllowedPrivateHosts');
    expect((textarea as HTMLTextAreaElement).value).toBe('n8n\n10.0.0.7');

    fireEvent.change(textarea, { target: { value: 'n8n\n hooks.internal , 10.0.0.7\n' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(putMock).toHaveBeenCalledWith(
        '/v1/settings/notifications.webhookAllowedPrivateHosts',
        {
          value: ['n8n', 'hooks.internal', '10.0.0.7'],
        },
      );
    });
  });
});
