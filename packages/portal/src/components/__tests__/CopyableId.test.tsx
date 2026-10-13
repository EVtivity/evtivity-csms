// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CopyableId } from '../copyable-id';
import { copyText } from '../ui/clipboard';

afterEach(() => {
  cleanup();
});

const ID = 'ses_000000000001';

describe('CopyableId', () => {
  it('copies the ID and shows Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<CopyableId id={ID} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(ID);
    });
    expect(await screen.findByText('common.copied')).toBeTruthy();
    expect(screen.getByTestId('copied-bubble').textContent).toBe('common.copied');
  });

  it('shows Copy failed, not Copied, when the browser refuses the write', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<CopyableId id={ID} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(screen.queryByText('common.copied')).toBeNull();
    expect(await screen.findByText('common.copyFailed')).toBeTruthy();
    warn.mockRestore();
  });
});

describe('copyText', () => {
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
