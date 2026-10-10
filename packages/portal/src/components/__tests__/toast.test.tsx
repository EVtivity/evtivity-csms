// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TOAST_DURATIONS_MS, type ToastVariantName } from '@evtivity/lib/toast-durations';
import { ToastProvider, useToast } from '../ui/toast';

function AddFavoriteButton(): React.JSX.Element {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        toast({ variant: 'success', title: 'Station added to favorites.' });
      }}
    >
      Add
    </button>
  );
}

describe('ToastProvider', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows a toast raised by a child component', () => {
    render(
      <ToastProvider>
        <AddFavoriteButton />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText('Station added to favorites.')).toBeDefined();
  });

  it('removes a toast when it is dismissed', () => {
    render(
      <ToastProvider>
        <AddFavoriteButton />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));

    expect(screen.queryByText('Station added to favorites.')).toBeNull();
  });

  it('shows nothing without a provider', () => {
    render(<AddFavoriteButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.queryByText('Station added to favorites.')).toBeNull();
  });
});

function RaiseVariant({ variant }: { variant: ToastVariantName }): React.JSX.Element {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        toast({ variant, title: `A ${variant} toast` });
      }}
    >
      Raise
    </button>
  );
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('ToastProvider auto-dismiss', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const variants: ToastVariantName[] = ['default', 'success', 'info', 'warning', 'destructive'];

  it.each(variants)('dismisses a %s toast after its default duration', (variant) => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <RaiseVariant variant={variant} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Raise' }));
    advance(TOAST_DURATIONS_MS[variant] - 1);
    expect(screen.queryByText(`A ${variant} toast`)).not.toBeNull();
    advance(1);
    expect(screen.queryByText(`A ${variant} toast`)).toBeNull();
  });

  it('pauses on hover and focus, and resumes when both end', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <RaiseVariant variant="destructive" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Raise' }));
    const toast = screen.getByRole('alert');
    const close = screen.getByRole('button', { name: 'common.dismiss' });
    fireEvent.mouseEnter(toast);
    fireEvent.focus(close);
    fireEvent.mouseLeave(toast);
    advance(TOAST_DURATIONS_MS.destructive * 2);
    expect(screen.queryByText('A destructive toast')).not.toBeNull();
    fireEvent.blur(close);
    advance(TOAST_DURATIONS_MS.destructive);
    expect(screen.queryByText('A destructive toast')).toBeNull();
  });

  it('announces toasts through a live region', () => {
    render(
      <ToastProvider>
        <RaiseVariant variant="success" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Raise' }));
    expect(screen.getByRole('status').parentElement?.getAttribute('aria-live')).toBe('polite');
  });
});
