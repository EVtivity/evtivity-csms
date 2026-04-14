// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CommandSchema } from '@/lib/ocpp-schema';

export function useOcppSchema(action: string, version?: string) {
  const versionPath = version === 'ocpp1.6' ? 'v16' : 'v21';
  return useQuery({
    queryKey: ['ocpp-schema', action, version ?? 'ocpp2.1'],
    queryFn: () => api.get<CommandSchema>(`/v1/ocpp/commands/${versionPath}/${action}/schema`),
    staleTime: Infinity,
    enabled: action !== '',
  });
}
