// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ApiError } from '@/lib/api';
import {
  StorageUnavailableDialog,
  isStorageNotConfiguredError,
  useStorageGuard,
} from '../StorageUnavailableDialog';

afterEach(() => {
  cleanup();
});

describe('StorageUnavailableDialog (portal)', () => {
  it('tells the driver to try again later, with one OK action', () => {
    const onOpenChange = vi.fn();
    render(<StorageUnavailableDialog open onOpenChange={onOpenChange} />);
    const dialog = screen.getByRole('dialog', { name: 'storageUnavailable.title' });
    expect(dialog.textContent).toContain('storageUnavailable.description');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['common.ok']);
    fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing while closed', () => {
    render(<StorageUnavailableDialog open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('matches the STORAGE_NOT_CONFIGURED code only', () => {
    expect(isStorageNotConfiguredError(new ApiError(400, { code: 'STORAGE_NOT_CONFIGURED' }))).toBe(
      true,
    );
    expect(isStorageNotConfiguredError(new ApiError(400, { code: 'VALIDATION_ERROR' }))).toBe(
      false,
    );
  });

  it('runs the picker while storage is set up, else opens the dialog', () => {
    const openPicker = vi.fn();
    const { result } = renderHook(() => useStorageGuard());
    act(() => {
      result.current.guard(true, openPicker);
    });
    expect(openPicker).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.guard(false, openPicker);
    });
    expect(openPicker).toHaveBeenCalledTimes(1);
    render(result.current.dialog);
    expect(screen.getByRole('dialog', { name: 'storageUnavailable.title' })).toBeTruthy();
  });

  it('opens the dialog for a storage error only', () => {
    const { result } = renderHook(() => useStorageGuard());
    let handled = true;
    act(() => {
      handled = result.current.handleUploadError(new Error('boom'));
    });
    expect(handled).toBe(false);
    act(() => {
      handled = result.current.handleUploadError(
        new ApiError(400, { code: 'STORAGE_NOT_CONFIGURED' }),
      );
    });
    expect(handled).toBe(true);
  });
});
