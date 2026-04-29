// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';
import { useHasPermission } from '@/lib/auth';
import { APP_VERSION } from '@/lib/version';

const VERSION_URL = 'https://evtivity.com/csms-version.txt';
const SESSION_FLAG = 'csms_update_checked';
const DISMISS_KEY = 'csms_update_dismissed';
const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;
const TOAST_DURATION_MS = 10_000;

interface DismissalRecord {
  version: string;
  at: number;
}

function parseVersion(v: string): number[] {
  const cleaned = v.replace(/^v/, '').trim();
  return cleaned.split('.').map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

function readDismissal(): DismissalRecord | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as DismissalRecord;
    if (typeof parsed.version !== 'string' || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function useUpdateCheck(): void {
  const isAdmin = useHasPermission('settings:write');
  const { toast } = useToast();
  const { t } = useTranslation();

  useEffect(() => {
    if (!isAdmin) return;
    if (sessionStorage.getItem(SESSION_FLAG) != null) return;
    sessionStorage.setItem(SESSION_FLAG, '1');

    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const res = await fetch(VERSION_URL, { signal: controller.signal });
        if (!res.ok) return;
        const latest = (await res.text()).trim();
        if (latest === '' || !/^v?\d+\.\d+/.test(latest)) return;
        if (!isNewer(latest, APP_VERSION)) return;

        const dismissal = readDismissal();
        if (
          dismissal != null &&
          dismissal.version === latest &&
          Date.now() - dismissal.at < DISMISS_WINDOW_MS
        ) {
          return;
        }

        const normalizedLatest = latest.startsWith('v') ? latest : `v${latest}`;
        const releaseUrl = `https://github.com/EVtivity/evtivity-csms/releases/tag/${normalizedLatest}`;

        localStorage.setItem(
          DISMISS_KEY,
          JSON.stringify({ version: latest, at: Date.now() } satisfies DismissalRecord),
        );

        toast({
          variant: 'info',
          title: t('updateCheck.title'),
          description: t('updateCheck.description', { version: normalizedLatest }),
          duration: TOAST_DURATION_MS,
          action: {
            label: t('updateCheck.viewRelease'),
            href: releaseUrl,
          },
        });
      } catch {
        // Network failure or aborted; silently ignore.
      }
    })();

    return () => {
      controller.abort();
    };
  }, [isAdmin, toast, t]);
}
