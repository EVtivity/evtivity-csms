// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';

/**
 * Under `['sims']`, so every SIM write (create, import, attach, detach, delete),
 * which invalidates `['sims']`, reads it again.
 */
export const SIMS_EXIST_KEY = ['sims', 'exist'] as const;

/**
 * Whether the caller may see at least one SIM: `GET /v1/sims?limit=1`, which
 * applies the SIM site scope (a site-restricted user counts only the SIMs they
 * may see). Read only with `sims:read` and while the SIM features are on; false
 * until the answer arrives and on an error, so the SIM Cards menu entry stays
 * hidden then (the page stays reachable by URL).
 */
export function useSimsExist(simEnabled: boolean): boolean {
  const canRead = useHasPermission('sims:read');
  const { data } = useQuery({
    queryKey: SIMS_EXIST_KEY,
    queryFn: () => api.get<{ total: number }>('/v1/sims?limit=1'),
    enabled: canRead && simEnabled,
    staleTime: 60_000,
  });
  return (data?.total ?? 0) > 0;
}
