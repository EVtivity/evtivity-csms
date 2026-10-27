// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A `yyyy-mm-dd` value that is a real calendar day, else ''. */
export function validDay(value: string | null): string {
  if (value == null || !DAY_PATTERN.test(value)) return '';
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : value;
}

/**
 * The API bounds of picked local days: the start of `from` and the last
 * millisecond of `to` (the log and audit lists include both bounds).
 */
export function dayRangeApiParams(from: string, to: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (from !== '') params['from'] = new Date(`${from}T00:00:00`).toISOString();
  if (to !== '') params['to'] = new Date(`${to}T23:59:59.999`).toISOString();
  return params;
}

export interface UrlDateRange {
  from: string;
  to: string;
  setFrom: (day: string) => void;
  setTo: (day: string) => void;
  clear: () => void;
  /** `from` and `to` as ISO bounds for the API, only those that are set. */
  apiParams: Record<string, string>;
}

/**
 * A From and To day filter kept in the URL (`from`, `to` as `yyyy-mm-dd`), so
 * it survives Back, a reload and a shared link, and stays when the page
 * switches tabs.
 */
export function useUrlDateRange(): UrlDateRange {
  const [searchParams, setSearchParams] = useSearchParams();
  const from = validDay(searchParams.get('from'));
  const to = validDay(searchParams.get('to'));

  const write = useCallback(
    (changes: Record<string, string>) => {
      setSearchParams(
        () => {
          // From the URL as it is now, not `prev` (frontend/ui.md).
          const next = new URLSearchParams(window.location.search);
          for (const [key, value] of Object.entries(changes)) {
            if (value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setFrom = useCallback(
    (day: string) => {
      write({ from: validDay(day) });
    },
    [write],
  );
  const setTo = useCallback(
    (day: string) => {
      write({ to: validDay(day) });
    },
    [write],
  );
  const clear = useCallback(() => {
    write({ from: '', to: '' });
  }, [write]);

  const apiParams = useMemo(() => dayRangeApiParams(from, to), [from, to]);

  return { from, to, setFrom, setTo, clear, apiParams };
}
