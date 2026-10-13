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
import { copyText } from '../ui/clipboard';

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
    // The visible feedback: the Copied bubble, not only the accessible name.
    expect((await screen.findByTestId('copied-bubble')).textContent).toBe('common.copied');
  });
});

describe('CopyableId', () => {
  it('copies the ID and shows a check and Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyableId id={UUID} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(UUID);
    });
    expect(await screen.findByText('common.copied')).toBeTruthy();
  });

  it('shows Copy failed, not Copied, when the browser refuses the write', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.assign(navigator, { clipboard: { writeText } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<CopyableId id={UUID} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(screen.queryByText('common.copied')).toBeNull();
    expect(await screen.findByText('common.copyFailed')).toBeTruthy();
    warn.mockRestore();
  });

  it('never grows past its container', () => {
    render(<CopyableId id={UUID} />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('max-w-full');
    const text = screen.getByTitle(UUID);
    expect(text.className).toContain('truncate');
  });

  it('shows the same Copied bubble as the copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyableId id={UUID} />);
    expect(screen.queryByTestId('copied-bubble')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect((await screen.findByTestId('copied-bubble')).textContent).toBe('common.copied');
    expect(writeText).toHaveBeenCalledWith(UUID);
  });
});

describe('CopyButton', () => {
  it('is the shared outline icon button that copies its value and names its state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton value='{"a":1}' label="test.copyLabel" />);
    const button = screen.getByRole('button', { name: 'test.copyLabel' });
    expect(button.getAttribute('data-testid')).toBe('copy-button');
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('{"a":1}');
    });
    expect(await screen.findByRole('button', { name: 'common.copied' })).toBeTruthy();
    expect((await screen.findByTestId('copied-bubble')).textContent).toBe('common.copied');
  });

  it('hides the Copied bubble again after two seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      render(<CopyButton value="x" />);
      fireEvent.click(screen.getByRole('button', { name: 'common.copy' }));
      expect(await screen.findByTestId('copied-bubble')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => {
        expect(screen.queryByTestId('copied-bubble')).toBeNull();
      });
      expect(screen.getByRole('button', { name: 'common.copy' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CopyButton with a visible label', () => {
  it('shows its text, then Copied after a copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton value="payload" text="common.copy" />);
    const button = screen.getByRole('button', { name: 'common.copy' });
    expect(button.textContent).toBe('common.copy');
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('payload');
    });
    const copied = await screen.findByRole('button', { name: 'common.copied' });
    expect(copied.textContent).toBe('common.copied');
  });

  it('keeps a separate accessible name and the ghost variant', () => {
    render(<CopyButton value="x" text="common.copy" label="ai.copyCode" variant="ghost" />);
    const button = screen.getByRole('button', { name: 'ai.copyCode' });
    expect(button.textContent).toBe('common.copy');
    expect(button.className).not.toContain('border-control');
  });

  it('keeps the icon-only default without text', () => {
    render(<CopyButton value="x" />);
    const button = screen.getByRole('button', { name: 'common.copy' });
    expect(button.textContent).toBe('');
  });
});

describe('copyText', () => {
  it('writes through the Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await copyText('abc');
    expect(writeText).toHaveBeenCalledWith('abc');
  });

  it('falls back to a hidden textarea without the Clipboard API (plain HTTP)', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const exec = vi.fn(() => true);
    Object.assign(document, { execCommand: exec });
    await copyText('abc');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when the fallback copy fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.assign(document, { execCommand: vi.fn(() => false) });
    await expect(copyText('abc')).rejects.toThrow('Clipboard unavailable');
  });
});
