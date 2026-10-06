// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const version = vi.hoisted(() => ({ current: '0.1.38-beta.1' }));
const toastMock = vi.hoisted(() => vi.fn());
const perm = vi.hoisted(() => ({ admin: true }));
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
vi.mock('@/lib/auth', () => ({ useHasPermission: () => perm.admin }));
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
    perm.admin = true;
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
    version.current = '0.1.38-beta.2';
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

  describe('dismissal and failures', () => {
    const DAY = 24 * 60 * 60 * 1000;

    async function settle(): Promise<void> {
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      await Promise.resolve();
      await Promise.resolve();
    }

    beforeEach(() => {
      version.current = '0.1.37';
    });

    it('does not check for a user without users:write', async () => {
      perm.admin = false;
      serveLatest('v0.1.38');
      renderHook(() => {
        useUpdateCheck();
      });
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('stays quiet when the version file request fails', async () => {
      fetchMock.mockResolvedValue({ ok: false, text: () => Promise.resolve('v9.9.9') });
      renderHook(() => {
        useUpdateCheck();
      });
      await settle();
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('stays quiet on a network error', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      renderHook(() => {
        useUpdateCheck();
      });
      await settle();
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('stays quiet when the same version was dismissed within a day', async () => {
      localStorage.setItem(
        'csms_update_dismissed',
        JSON.stringify({ version: 'v0.1.38', at: Date.now() - DAY + 60_000 }),
      );
      serveLatest('v0.1.38');
      renderHook(() => {
        useUpdateCheck();
      });
      await settle();
      expect(toastMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a dismissal older than a day', JSON.stringify({ version: 'v0.1.38', at: 0 })],
      ['a dismissal of another version', JSON.stringify({ version: 'v0.1.37', at: Date.now() })],
      ['malformed dismissal JSON', '{not json'],
      ['a dismissal with wrong field types', JSON.stringify({ version: 38, at: 'now' })],
    ])('shows the toast despite %s', async (_label, stored) => {
      localStorage.setItem('csms_update_dismissed', stored);
      serveLatest('v0.1.38');
      renderHook(() => {
        useUpdateCheck();
      });
      await waitFor(() => {
        expect(toastMock).toHaveBeenCalledTimes(1);
      });
    });

    it('adds the v prefix to the release link and records a dismissal', async () => {
      serveLatest('0.1.38');
      renderHook(() => {
        useUpdateCheck();
      });
      await waitFor(() => {
        expect(toastMock).toHaveBeenCalledTimes(1);
      });
      const arg = toastMock.mock.calls[0]?.[0] as {
        action: { href: string };
        persistent: boolean;
        onDismiss: () => void;
      };
      expect(arg.action.href).toBe(
        'https://github.com/EVtivity/evtivity-csms/releases/tag/v0.1.38',
      );
      expect(arg.persistent).toBe(true);

      arg.onDismiss();
      const stored = JSON.parse(localStorage.getItem('csms_update_dismissed') ?? '{}') as {
        version: string;
        at: number;
      };
      expect(stored.version).toBe('0.1.38');
      expect(Math.abs(Date.now() - stored.at)).toBeLessThan(5_000);
    });
  });
});
