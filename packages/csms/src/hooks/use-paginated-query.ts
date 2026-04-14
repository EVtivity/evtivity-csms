// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useCallback } from 'react';
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
}

const LIMIT = 10;

export function usePaginatedQuery<T>(
  queryKey: string,
  baseUrl: string,
  extraParams?: Record<string, string>,
): UsePaginatedQueryResult<T> {
  const [page, setPage] = useState(1);
  const [search, setSearchState] = useState('');

  const setSearch = useCallback((value: string) => {
    setSearchState(value);
    setPage(1);
  }, []);

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
  } = useQuery({
    queryKey: [queryKey, page, search, ...(extraParams ? Object.values(extraParams) : [])],
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
  };
}
