// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';
import { useHasPermission } from '@/lib/auth';
import { APP_VERSION } from '@/lib/version';
import { isNewerVersion } from '@/lib/version-compare';

const VERSION_URL = 'https://evtivity.com/csms-version.txt';
const DISMISS_KEY = 'csms_update_dismissed';
const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;

interface DismissalRecord {
  version: string;
  at: number;
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
  const isAdmin = useHasPermission('users:write');
  const { toast } = useToast();
  const { t } = useTranslation();
  const shownRef = useRef(false);

  useEffect(() => {
    if (!isAdmin) return;
    if (shownRef.current) return;

    void (async (): Promise<void> => {
      try {
        const res = await fetch(VERSION_URL);
        if (!res.ok) return;
        const latest = (await res.text()).trim();
        // Semver precedence: a 0.1.38-beta.1 install is told about 0.1.38.
        if (!isNewerVersion(latest, APP_VERSION)) return;

        const dismissal = readDismissal();
        if (
          dismissal != null &&
          dismissal.version === latest &&
          Date.now() - dismissal.at < DISMISS_WINDOW_MS
        ) {
          return;
        }

        if (shownRef.current) return;
        shownRef.current = true;

        const normalizedLatest = latest.startsWith('v') ? latest : `v${latest}`;
        const releaseUrl = `https://github.com/EVtivity/evtivity-csms/releases/tag/${normalizedLatest}`;

        toast({
          variant: 'info',
          title: t('updateCheck.title'),
          description: t('updateCheck.description', { version: normalizedLatest }),
          persistent: true,
          action: {
            label: t('updateCheck.viewRelease'),
            href: releaseUrl,
          },
          onDismiss: () => {
            localStorage.setItem(
              DISMISS_KEY,
              JSON.stringify({ version: latest, at: Date.now() } satisfies DismissalRecord),
            );
          },
        });
      } catch {
        // Network failure; silently ignore.
      }
    })();
  }, [isAdmin, toast, t]);
}
