// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { GuidedEmptyState } from '../ui/guided-empty-state';

afterEach(() => {
  cleanup();
});

describe('GuidedEmptyState', () => {
  it('shows the title, the description and the first actions', () => {
    render(
      <GuidedEmptyState
        title="No RFID Cards Yet"
        description="Add the first card."
        actions={<button type="button">Add RFID Card</button>}
      />,
    );
    const empty = screen.getByTestId('empty-state');
    expect(within(empty).getByText('No RFID Cards Yet')).toBeTruthy();
    expect(within(empty).getByText('Add the first card.')).toBeTruthy();
    expect(within(empty).getByRole('button', { name: 'Add RFID Card' })).toBeTruthy();
  });

  it('wraps its actions and lets them fill a phone row, centered from sm', () => {
    render(
      <GuidedEmptyState title="t" description="d" actions={<button type="button">Act</button>} />,
    );
    const row = screen.getByRole('button', { name: 'Act' }).parentElement as HTMLElement;
    expect(row.className).toContain('flex-wrap');
    expect(row.className).toContain('*:grow');
    expect(row.className).toContain('sm:*:grow-0');
    // The text stays within a readable width on wide screens.
    expect(screen.getByTestId('empty-state').className).toContain('max-w-md');
  });

  it('renders no action row without actions', () => {
    render(<GuidedEmptyState title="t" description="d" />);
    expect(within(screen.getByTestId('empty-state')).queryByRole('button')).toBeNull();
  });
});
