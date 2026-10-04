// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const version = vi.hoisted(() => ({ current: '0.1.38-beta.1' }));
const toastMock = vi.hoisted(() => vi.fn());
const t = vi.hoisted(
  () =>
    (key: string): string =>
      key,
);

vi.mock('@/lib/version', () => ({
  get APP_VERSION(): string {
    return version.current;
  },
}));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

import { useUpdateCheck } from '../use-update-check';

const fetchMock = vi.fn();

function serveLatest(body: string): void {
  fetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve(body) });
}

describe('useUpdateCheck', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    localStorage.clear();
    toastMock.mockReset();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tells a prerelease install about the stable release of the same version', async () => {
    version.current = '0.1.38-beta.1';
    serveLatest('v0.1.38\n');
    renderHook(() => {
      useUpdateCheck();
    });
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledTimes(1);
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          href: 'https://github.com/EVtivity/evtivity-csms/releases/tag/v0.1.38',
        }) as unknown,
      }),
    );
  });

  it('stays quiet when the published stable version is older than the prerelease', async () => {
    version.current = '0.1.38-nightly.2';
    serveLatest('v0.1.37');
    renderHook(() => {
      useUpdateCheck();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('stays quiet on the current stable version and on a malformed response', async () => {
    version.current = '0.1.38';
    serveLatest('v0.1.38');
    renderHook(() => {
      useUpdateCheck();
    });
    serveLatest('<html>not found</html>');
    renderHook(() => {
      useUpdateCheck();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    await Promise.resolve();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
