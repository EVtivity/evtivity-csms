// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    post: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { NotificationDrawer } from '../NotificationDrawer';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('NotificationDrawer', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not render when closed', () => {
    const { container } = render(<NotificationDrawer open={false} onClose={() => {}} />, {
      wrapper: createWrapper(),
    });
    expect(container.querySelector('[class*="fixed"]')).toBeNull();
  });

  it('renders overlay and panel when open', () => {
    render(<NotificationDrawer open={true} onClose={() => {}} />, { wrapper: createWrapper() });
    expect(screen.getByText('notifications.title')).toBeTruthy();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(<NotificationDrawer open={true} onClose={onClose} />, { wrapper: createWrapper() });
    const closeButton = screen.getByLabelText('Close');
    closeButton.click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows empty state when no notifications', () => {
    render(<NotificationDrawer open={true} onClose={() => {}} />, { wrapper: createWrapper() });
    expect(screen.getByText('notifications.noNotifications')).toBeTruthy();
  });
});
