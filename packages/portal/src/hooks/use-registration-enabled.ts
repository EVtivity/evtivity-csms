// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface RegistrationFeature {
  registrationEnabled?: boolean;
}

/**
 * Whether drivers can create their own account (portal.registrationEnabled).
 * Undefined while the features load or when they cannot be read, so callers
 * decide whether an unknown state offers sign-up or not.
 */
export function useRegistrationEnabled(): boolean | undefined {
  const { data } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () => api.get<RegistrationFeature>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });
  return data?.registrationEnabled;
}
