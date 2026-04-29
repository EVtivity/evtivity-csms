// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const DISMISS_KEY = 'csms_update_dismissed';
export const DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const VERSION_PATTERN = /^v?\d+\.\d+/;

export interface DismissalRecord {
  version: string;
  at: number;
}

export function parseVersion(v: string): number[] {
  const cleaned = v.trim().replace(/^v/, '');
  return cleaned.split('.').map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

export function isNewer(latest: string, current: string): boolean {
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

export function readDismissal(
  storage: Pick<Storage, 'getItem'> = localStorage,
): DismissalRecord | null {
  try {
    const raw = storage.getItem(DISMISS_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as DismissalRecord;
    if (typeof parsed.version !== 'string' || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isDismissalActive(
  dismissal: DismissalRecord | null,
  latest: string,
  now: number,
): boolean {
  if (dismissal == null) return false;
  if (dismissal.version !== latest) return false;
  return now - dismissal.at < DISMISS_WINDOW_MS;
}

export function shouldShowToast(
  latest: string,
  current: string,
  dismissal: DismissalRecord | null,
  now: number,
): boolean {
  if (latest === '' || !VERSION_PATTERN.test(latest)) return false;
  if (!isNewer(latest, current)) return false;
  if (isDismissalActive(dismissal, latest, now)) return false;
  return true;
}

export function normalizeVersionTag(v: string): string {
  return v.startsWith('v') ? v : `v${v}`;
}

export function buildReleaseUrl(latest: string): string {
  return `https://github.com/EVtivity/evtivity-csms/releases/tag/${normalizeVersionTag(latest)}`;
}
