// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useRef } from 'react';
import { tryParseJson } from '@evtivity/lib/safe-json';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { APP_VERSION } from '@/lib/version';
import { isNewerVersion } from '@/lib/version-compare';

// The worker reads the latest release from the EVtivity website once a day
// (system.updateCheckEnabled); the browser asks only the own API, never the
// website (security review case 385).
const UPDATE_CHECK_PATH = '/v1/system/update-check';
const DISMISS_KEY = 'csms_update_dismissed';
const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;

interface UpdateCheck {
  enabled: boolean;
  latestVersion: string | null;
  checkedAt: string | null;
}

interface DismissalRecord {
  version: string;
  at: number;
}

function readDismissal(): DismissalRecord | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DISMISS_KEY);
  } catch (err) {
    console.warn('Read the update dismissal from localStorage failed', err);
    return null;
  }
  const parsed = tryParseJson(raw);
  if (parsed == null || typeof parsed !== 'object') return null;
  const record = parsed as Partial<DismissalRecord>;
  if (typeof record.version !== 'string' || typeof record.at !== 'number') return null;
  return { version: record.version, at: record.at };
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
        const check = await api.get<UpdateCheck>(UPDATE_CHECK_PATH);
        const latest = check.latestVersion?.trim() ?? null;
        if (!check.enabled || latest == null) return;
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
          action: {
            label: t('updateCheck.viewRelease'),
            href: releaseUrl,
          },
          onClose: () => {
            localStorage.setItem(
              DISMISS_KEY,
              JSON.stringify({ version: latest, at: Date.now() } satisfies DismissalRecord),
            );
          },
        });
      } catch (err) {
        console.warn('Check for a newer CSMS version failed', err);
      }
    })();
  }, [isAdmin, toast, t]);
}
