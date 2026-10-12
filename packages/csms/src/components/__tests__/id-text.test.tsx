// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { IdText } from '../ui/id-text';
import { CopyableId } from '../copyable-id';
import { CopyButton } from '../ui/copy-button';

afterEach(() => {
  cleanup();
});

const UUID = 'e2b4b93a-3d6b-452b-812c-a67d3395075b';

describe('IdText', () => {
  it('truncates to its container with the full value in a tooltip', () => {
    render(<IdText value={UUID} />);
    const text = screen.getByTestId('id-text');
    expect(text.textContent).toBe(UUID);
    expect(text.getAttribute('title')).toBe(UUID);
    expect(text.className).toContain('truncate');
    expect(text.className).toContain('min-w-0');
    expect(text.parentElement?.className).toContain('max-w-full');
  });

  it('copies the full value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<IdText value={UUID} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(UUID);
    });
    expect(await screen.findByRole('button', { name: 'common.copied' })).toBeTruthy();
  });
});

describe('CopyableId', () => {
  it('never grows past its container', () => {
    render(<CopyableId id={UUID} />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('max-w-full');
    const text = screen.getByTitle(UUID);
    expect(text.className).toContain('truncate');
  });
});

describe('CopyButton', () => {
  it('is the shared outline icon button that copies its value and names its state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton value='{"a":1}' label="aiInsights.action.arguments" />);
    const button = screen.getByRole('button', { name: 'aiInsights.action.arguments' });
    expect(button.getAttribute('data-testid')).toBe('copy-button');
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('{"a":1}');
    });
    expect(await screen.findByRole('button', { name: 'common.copied' })).toBeTruthy();
  });
});
