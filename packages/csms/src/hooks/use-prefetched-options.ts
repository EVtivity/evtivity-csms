// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * A WebAuthn challenge lives 5 minutes. Options older than this are fetched
 * again, so a prompt never starts on a challenge about to expire.
 */
export const PREFETCHED_OPTIONS_MAX_AGE_MS = 4 * 60_000;

export interface PrefetchedOptions<T> {
  /**
   * The options fetched before the click, or null when none are ready. Each set
   * serves one prompt: taking it fetches the next one.
   */
  take: () => T | null;
  /** Fetches options now, for a click that found none ready. */
  load: () => Promise<T>;
}

/**
 * Fetches the options of a passkey prompt before the user clicks, and again
 * before they expire, so the click can start the browser prompt at once.
 * Safari allows navigator.credentials only while the click's user activation
 * lasts, which a fetch in the click handler can use up.
 */
export function usePrefetchedOptions<T>(
  fetcher: () => Promise<T>,
  enabled: boolean,
): PrefetchedOptions<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const ready = useRef<{ options: T; fetchedAt: number } | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    ready.current = null;
    if (!enabled) return;
    const run = { active: true };
    let refresh: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const options = await fetcherRef.current();
        if (!run.active) return;
        ready.current = { options, fetchedAt: Date.now() };
        refresh = setTimeout(() => {
          setRound((r) => r + 1);
        }, PREFETCHED_OPTIONS_MAX_AGE_MS);
      } catch (err) {
        // The click fetches the options itself and shows that error.
        console.warn('Passkey options prefetch failed, fetching them on click', err);
      }
    })();
    return () => {
      run.active = false;
      clearTimeout(refresh);
    };
  }, [enabled, round]);

  return useMemo(
    () => ({
      take: () => {
        const entry = ready.current;
        if (entry == null) return null;
        ready.current = null;
        setRound((r) => r + 1);
        return Date.now() - entry.fetchedAt < PREFETCHED_OPTIONS_MAX_AGE_MS ? entry.options : null;
      },
      load: () => fetcherRef.current(),
    }),
    [],
  );
}
