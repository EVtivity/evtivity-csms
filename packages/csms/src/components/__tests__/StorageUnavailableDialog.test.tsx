// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const { perms, flags } = vi.hoisted(() => ({
  perms: { granted: new Set<string>(), allSites: true },
  flags: { fileStorageEnabled: true },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { path?: string }) =>
      opts?.path != null ? `${key}(${opts.path})` : key,
  }),
}));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (perm: string) => perms.granted.has(perm),
  useHasAllSiteAccess: () => perms.allSites,
}));
const featureFlagsMock = vi.fn<(options?: { enabled?: boolean }) => { flags: typeof flags }>(
  () => ({ flags }),
);
vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: (options?: { enabled?: boolean }) => featureFlagsMock(options),
}));

import { ApiError } from '@/lib/api';
import {
  FILE_STORAGE_SETTINGS_PATH,
  StorageUnavailableDialog,
  isStorageNotConfiguredError,
  useStorageGuard,
} from '../StorageUnavailableDialog';

const ADMIN = ['settings.integrations:read', 'settings.system:write'];

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderDialog(onOpenChange = vi.fn()): { onOpenChange: (open: boolean) => void } {
  render(
    <MemoryRouter initialEntries={['/stations']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <StorageUnavailableDialog open onOpenChange={onOpenChange} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onOpenChange };
}

afterEach(() => {
  cleanup();
  perms.granted = new Set();
  perms.allSites = true;
  flags.fileStorageEnabled = true;
  featureFlagsMock.mockClear();
});

describe('StorageUnavailableDialog', () => {
  it('renders nothing while closed', () => {
    render(<StorageUnavailableDialog open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names the problem and the Settings path, with one OK action for a user without settings access', () => {
    const { onOpenChange } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'storageUnavailable.title' });
    expect(dialog.textContent).toContain(
      'storageUnavailable.description(nav.settings > settings.integrations > settings.s3)',
    );
    expect(screen.queryByRole('button', { name: 'storageUnavailable.openSettings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'common.ok' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers the Settings tab to a user who can set up storage, and opens it', () => {
    perms.granted = new Set(ADMIN);
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'storageUnavailable.openSettings' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('where').textContent).toBe(FILE_STORAGE_SETTINGS_PATH);
  });

  it('offers no Settings button to a site-restricted user', () => {
    perms.granted = new Set(ADMIN);
    perms.allSites = false;
    renderDialog();
    expect(screen.queryByRole('button', { name: 'storageUnavailable.openSettings' })).toBeNull();
  });
});

describe('isStorageNotConfiguredError', () => {
  it('matches the STORAGE_NOT_CONFIGURED code only', () => {
    expect(isStorageNotConfiguredError(new ApiError(400, { code: 'STORAGE_NOT_CONFIGURED' }))).toBe(
      true,
    );
    expect(isStorageNotConfiguredError(new ApiError(400, { code: 'VALIDATION_ERROR' }))).toBe(
      false,
    );
    expect(isStorageNotConfiguredError(new Error('STORAGE_NOT_CONFIGURED'))).toBe(false);
  });
});

describe('useStorageGuard', () => {
  it('opens the picker while storage is set up, the dialog while it is off', () => {
    const openPicker = vi.fn();
    flags.fileStorageEnabled = false;
    const { result } = renderHook(() => useStorageGuard());
    act(() => {
      result.current.guard(openPicker);
    });
    expect(openPicker).not.toHaveBeenCalled();
    render(result.current.dialog);
    expect(screen.getByRole('dialog', { name: 'storageUnavailable.title' })).toBeTruthy();
  });

  it('uses the given answer over the feature flag and sends no flag request then', () => {
    const openPicker = vi.fn();
    flags.fileStorageEnabled = false;
    const { result } = renderHook(() => useStorageGuard(true));
    expect(featureFlagsMock).toHaveBeenLastCalledWith({ enabled: false });
    act(() => {
      result.current.guard(openPicker);
    });
    expect(openPicker).toHaveBeenCalledTimes(1);
  });

  it('opens the dialog for a storage error only', () => {
    const { result } = renderHook(() => useStorageGuard());
    let handled = false;
    act(() => {
      handled = result.current.handleUploadError(new ApiError(400, { code: 'VALIDATION_ERROR' }));
    });
    expect(handled).toBe(false);
    act(() => {
      handled = result.current.handleUploadError(
        new ApiError(400, { code: 'STORAGE_NOT_CONFIGURED' }),
      );
    });
    expect(handled).toBe(true);
    render(result.current.dialog);
    expect(screen.getByRole('dialog', { name: 'storageUnavailable.title' })).toBeTruthy();
  });
});
