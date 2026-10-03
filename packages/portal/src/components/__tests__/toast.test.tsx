// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText('Station added to favorites.')).toBeNull();
  });

  it('shows nothing without a provider', () => {
    render(<AddFavoriteButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.queryByText('Station added to favorites.')).toBeNull();
  });
});
