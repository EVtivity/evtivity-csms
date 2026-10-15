// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface PaginatedResponse<T> {
  data: T[];
  total: number;
}

interface UsePaginatedQueryResult<T> {
  data: T[] | undefined;
  total: number;
  page: number;
  totalPages: number;
  setPage: (page: number) => void;
  search: string;
  setSearch: (search: string) => void;
  isLoading: boolean;
  isError: boolean;
  /** Loads the current page again (the Retry of a load error). */
  refetch: () => void;
}

const LIMIT = 10;

/**
 * A paginated list query. `queryKey` is the key prefix: a string or an array
 * such as `['sessions', id, 'meter-values']`, so an invalidation of the
 * prefix (live events) refreshes the list. The full request URL ends the key,
 * so two lists with the same prefix and different URLs (another record's
 * events, another filter) never share a cache entry.
 */
export function usePaginatedQuery<T>(
  queryKey: string | readonly unknown[],
  baseUrl: string,
  extraParams?: Record<string, string>,
  initialSearch = '',
): UsePaginatedQueryResult<T> {
  const [page, setPage] = useState(1);
  const [search, setSearchState] = useState(initialSearch);

  const setSearch = useCallback((value: string) => {
    setSearchState(value);
    setPage(1);
  }, []);

  // Reset to page 1 when filter params change. Without this a user sitting
  // on page 5 of an unfiltered list who picks a filter that shrinks the
  // result to a single page would be stuck rendering page 5 of 1.
  const extraParamsKey = extraParams != null ? JSON.stringify(extraParams) : '';
  useEffect(() => {
    setPage(1);
  }, [extraParamsKey]);

  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(LIMIT));
  if (search) {
    params.set('search', search);
  }
  if (extraParams) {
    for (const [key, val] of Object.entries(extraParams)) {
      if (val) params.set(key, val);
    }
  }

  const url = `${baseUrl}?${params.toString()}`;

  const {
    data: response,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: [...(typeof queryKey === 'string' ? [queryKey] : queryKey), url],
    queryFn: () => api.get<PaginatedResponse<T>>(url),
  });

  const total = response?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return {
    data: response?.data,
    total,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
    isLoading,
    isError,
    refetch: () => {
      void refetch();
    },
  };
}
