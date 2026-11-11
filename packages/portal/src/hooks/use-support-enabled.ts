// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface SupportFeature {
  supportEnabled?: boolean;
}

/**
 * Whether drivers can open support cases (support.enabled). Undefined while
 * the features load or when they cannot be read; callers treat only an
 * explicit false as disabled, as the nav and home cards do.
 */
export function useSupportEnabled(): boolean | undefined {
  const { data } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () => api.get<SupportFeature>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });
  return data?.supportEnabled;
}
