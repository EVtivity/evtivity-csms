// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface EntityNeighbors {
  prevId: string | null;
  nextId: string | null;
}

export function useEntityNeighbors(resource: string, id: string | undefined): EntityNeighbors {
  const { data } = useQuery({
    queryKey: ['entity-neighbors', resource, id],
    queryFn: () => api.get<EntityNeighbors>(`/v1/${resource}/${id ?? ''}/neighbors`),
    enabled: id != null && id !== '',
  });
  return { prevId: data?.prevId ?? null, nextId: data?.nextId ?? null };
}
