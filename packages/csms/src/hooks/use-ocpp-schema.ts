// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CommandSchema } from '@/lib/ocpp-schema';

/** The command form schema of a station's protocol: 1.6, 2.0.1, else 2.1. */
export function ocppSchemaUrl(action: string, version?: string): string {
  if (version === 'ocpp1.6') return `/v1/ocpp/commands/v16/${action}/schema`;
  const query = version === 'ocpp2.0.1' ? '?protocol=ocpp2.0.1' : '';
  return `/v1/ocpp/commands/v21/${action}/schema${query}`;
}

export function useOcppSchema(action: string, version?: string) {
  return useQuery({
    queryKey: ['ocpp-schema', action, version ?? 'ocpp2.1'],
    queryFn: () => api.get<CommandSchema>(ocppSchemaUrl(action, version)),
    staleTime: Infinity,
    enabled: action !== '',
  });
}
