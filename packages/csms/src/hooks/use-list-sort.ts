// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

export type ListSortOrder = 'asc' | 'desc';

/** The sort of one list table, kept in the URL (`sort`, `order`). */
export interface ListSort<K extends string = string> {
  /** The sorted column key, or null for the list's default order. */
  sort: K | null;
  order: ListSortOrder;
  /** Ascending, then descending, then back to the default order. */
  toggle: (key: K) => void;
  /**
   * The query params to send with the list request (`sort`, `order`), empty for the
   * default order. Pass them to `usePaginatedQuery` with the filters, so a new sort
   * starts again at page 1.
   */
  params: Record<string, string>;
}

/**
 * The URL sort of a list table (`frontend/ui.md`, "Sortable columns"). Only keys in `keys`
 * count: a `sort` in the URL that this table does not offer (an old link, another tab's
 * sort) is ignored, so the request never carries a key the API would refuse.
 */
export function useListSort<K extends string>(keys: readonly K[]): ListSort<K> {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawSort = searchParams.get('sort');
  const rawOrder = searchParams.get('order');
  const sort =
    rawSort != null && (keys as readonly string[]).includes(rawSort) ? (rawSort as K) : null;
  const order: ListSortOrder = sort != null && rawOrder === 'desc' ? 'desc' : 'asc';

  const toggle = useCallback(
    (key: K) => {
      setSearchParams(
        () => {
          // From the URL as it is now, not `prev` (see `useTab`).
          const next = new URLSearchParams(window.location.search);
          const currentSort = next.get('sort');
          const currentOrder = next.get('order') === 'desc' ? 'desc' : 'asc';
          if (currentSort !== key) {
            next.set('sort', key);
            next.set('order', 'asc');
          } else if (currentOrder === 'asc') {
            next.set('order', 'desc');
          } else {
            next.delete('sort');
            next.delete('order');
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const params = useMemo<Record<string, string>>(
    () => (sort == null ? {} : { sort, order }),
    [sort, order],
  );

  return { sort, order, toggle, params };
}
