// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { EmptyState, ErrorState, LoadingState } from '../ui/content-state';

afterEach(() => {
  cleanup();
});

describe('content states', () => {
  it('shows the loading logo as a status', () => {
    render(<LoadingState />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('common.loading');
  });

  it('shows the load error with an outline Retry at the default height', () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('common.loadError');
    expect(alert.className).toContain('text-center');
    const retry = screen.getByRole('button', { name: 'common.retry' });
    expect(retry.className).toContain('h-10');
    expect(retry.className).toContain('border');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('takes its own message and Retry label, and no button without onRetry', () => {
    const { rerender } = render(
      <ErrorState message="Passkeys failed" retryLabel="Try Again" onRetry={() => undefined} />,
    );
    expect(screen.getByText('Passkeys failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
    rerender(<ErrorState />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('centers the empty text in muted color', () => {
    render(<EmptyState>No sessions</EmptyState>);
    const empty = screen.getByTestId('empty-state');
    expect(empty.textContent).toBe('No sessions');
    expect(empty.className).toContain('text-center');
    expect(empty.className).toContain('text-muted-foreground');
  });
});
