// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  DISMISS_KEY,
  DISMISS_WINDOW_MS,
  buildReleaseUrl,
  isDismissalActive,
  isNewer,
  normalizeVersionTag,
  parseVersion,
  readDismissal,
  shouldShowToast,
} from '../update-check-helpers';
import type { DismissalRecord } from '../update-check-helpers';

describe('parseVersion', () => {
  it('strips a leading v', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]);
  });

  it('parses without a leading v', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
  });

  it('handles two-segment versions', () => {
    expect(parseVersion('v1.2')).toEqual([1, 2]);
  });

  it('handles four-segment versions', () => {
    expect(parseVersion('v1.2.3.4')).toEqual([1, 2, 3, 4]);
  });

  it('treats non-numeric segments as 0', () => {
    expect(parseVersion('v1.beta.3')).toEqual([1, 0, 3]);
  });

  it('trims whitespace', () => {
    expect(parseVersion('  v1.2.3  ')).toEqual([1, 2, 3]);
  });
});

describe('isNewer', () => {
  it('returns true when latest patch > current', () => {
    expect(isNewer('v0.1.2', 'v0.1.1')).toBe(true);
  });

  it('returns true when latest minor > current', () => {
    expect(isNewer('v0.2.0', 'v0.1.9')).toBe(true);
  });

  it('returns true when latest major > current', () => {
    expect(isNewer('v1.0.0', 'v0.99.99')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewer('v0.1.2', 'v0.1.2')).toBe(false);
  });

  it('returns false when latest is older', () => {
    expect(isNewer('v0.1.1', 'v0.1.2')).toBe(false);
  });

  it('compares mixed v-prefix and bare versions', () => {
    expect(isNewer('v0.1.2', '0.1.1')).toBe(true);
    expect(isNewer('0.1.2', 'v0.1.1')).toBe(true);
  });

  it('handles segment-length mismatch by treating missing as 0', () => {
    expect(isNewer('v1.0.1', 'v1.0')).toBe(true);
    expect(isNewer('v1.0', 'v1.0.0')).toBe(false);
    expect(isNewer('v1.0', 'v1.0.1')).toBe(false);
  });
});

describe('readDismissal', () => {
  function mockStorage(value: string | null): Pick<Storage, 'getItem'> {
    return { getItem: () => value };
  }

  it('returns null when storage is empty', () => {
    expect(readDismissal(mockStorage(null))).toBeNull();
  });

  it('returns the parsed record when valid', () => {
    const record = { version: 'v0.1.2', at: 1234567890 };
    expect(readDismissal(mockStorage(JSON.stringify(record)))).toEqual(record);
  });

  it('returns null on malformed JSON', () => {
    expect(readDismissal(mockStorage('not json'))).toBeNull();
  });

  it('returns null when version field is missing', () => {
    expect(readDismissal(mockStorage(JSON.stringify({ at: 123 })))).toBeNull();
  });

  it('returns null when at field is missing', () => {
    expect(readDismissal(mockStorage(JSON.stringify({ version: 'v0.1.2' })))).toBeNull();
  });

  it('returns null when at is not a number', () => {
    expect(
      readDismissal(mockStorage(JSON.stringify({ version: 'v0.1.2', at: 'soon' }))),
    ).toBeNull();
  });

  it('uses the localStorage default storage', () => {
    expect(DISMISS_KEY).toBe('csms_update_dismissed');
  });
});

describe('isDismissalActive', () => {
  const NOW = 1_000_000_000_000;

  it('returns false when dismissal is null', () => {
    expect(isDismissalActive(null, 'v0.1.2', NOW)).toBe(false);
  });

  it('returns false when version differs', () => {
    const dismissal: DismissalRecord = { version: 'v0.1.1', at: NOW };
    expect(isDismissalActive(dismissal, 'v0.1.2', NOW)).toBe(false);
  });

  it('returns true within the 24h window for same version', () => {
    const dismissal: DismissalRecord = { version: 'v0.1.2', at: NOW - 1000 };
    expect(isDismissalActive(dismissal, 'v0.1.2', NOW)).toBe(true);
  });

  it('returns false when older than 24h for same version', () => {
    const dismissal: DismissalRecord = { version: 'v0.1.2', at: NOW - DISMISS_WINDOW_MS - 1 };
    expect(isDismissalActive(dismissal, 'v0.1.2', NOW)).toBe(false);
  });

  it('returns true at the exact boundary minus 1ms', () => {
    const dismissal: DismissalRecord = { version: 'v0.1.2', at: NOW - DISMISS_WINDOW_MS + 1 };
    expect(isDismissalActive(dismissal, 'v0.1.2', NOW)).toBe(true);
  });

  it('returns false at the exact 24h mark', () => {
    const dismissal: DismissalRecord = { version: 'v0.1.2', at: NOW - DISMISS_WINDOW_MS };
    expect(isDismissalActive(dismissal, 'v0.1.2', NOW)).toBe(false);
  });
});

describe('shouldShowToast', () => {
  const NOW = 1_000_000_000_000;
  const CURRENT = 'v0.1.1';

  it('shows when latest is newer and no dismissal', () => {
    expect(shouldShowToast('v0.1.2', CURRENT, null, NOW)).toBe(true);
  });

  it('does not show when latest equals current', () => {
    expect(shouldShowToast('v0.1.1', CURRENT, null, NOW)).toBe(false);
  });

  it('does not show when latest is older', () => {
    expect(shouldShowToast('v0.1.0', CURRENT, null, NOW)).toBe(false);
  });

  it('does not show when dismissal is active for the same latest version', () => {
    const dismissal: DismissalRecord = { version: 'v0.1.2', at: NOW - 1000 };
    expect(shouldShowToast('v0.1.2', CURRENT, dismissal, NOW)).toBe(false);
  });

  it('shows when dismissal is for a different (older) version', () => {
    const dismissal: DismissalRecord = { version: 'v0.1.2', at: NOW - 1000 };
    expect(shouldShowToast('v0.1.3', CURRENT, dismissal, NOW)).toBe(true);
  });

  it('shows when dismissal expired', () => {
    const dismissal: DismissalRecord = { version: 'v0.1.2', at: NOW - DISMISS_WINDOW_MS - 1 };
    expect(shouldShowToast('v0.1.2', CURRENT, dismissal, NOW)).toBe(true);
  });

  it('does not show when latest is empty string', () => {
    expect(shouldShowToast('', CURRENT, null, NOW)).toBe(false);
  });

  it('does not show when latest is malformed', () => {
    expect(shouldShowToast('not-a-version', CURRENT, null, NOW)).toBe(false);
    expect(shouldShowToast('1', CURRENT, null, NOW)).toBe(false);
    expect(shouldShowToast('v1', CURRENT, null, NOW)).toBe(false);
  });

  it('shows for valid bare version (no v prefix)', () => {
    expect(shouldShowToast('0.1.2', CURRENT, null, NOW)).toBe(true);
  });
});

describe('normalizeVersionTag', () => {
  it('adds v prefix when missing', () => {
    expect(normalizeVersionTag('0.1.2')).toBe('v0.1.2');
  });

  it('keeps v prefix when present', () => {
    expect(normalizeVersionTag('v0.1.2')).toBe('v0.1.2');
  });
});

describe('buildReleaseUrl', () => {
  it('builds the GitHub release URL from a v-prefixed tag', () => {
    expect(buildReleaseUrl('v0.1.2')).toBe(
      'https://github.com/EVtivity/evtivity-csms/releases/tag/v0.1.2',
    );
  });

  it('builds the GitHub release URL from a bare version', () => {
    expect(buildReleaseUrl('0.1.2')).toBe(
      'https://github.com/EVtivity/evtivity-csms/releases/tag/v0.1.2',
    );
  });
});
