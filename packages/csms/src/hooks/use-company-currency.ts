// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { resolveCompanyCurrency } from '@/lib/company-currency';

export interface CompanyCurrencyState {
  /** Undefined while loading or after a failed load. */
  currency: string | undefined;
  isError: boolean;
  refetch: () => void;
}

/**
 * The platform currency (`company.currency`). Read from the public branding
 * endpoint so it works without settings permissions.
 */
export function useCompanyCurrency(): CompanyCurrencyState {
  const {
    data: branding,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });
  return {
    currency: resolveCompanyCurrency(branding),
    isError,
    refetch: () => {
      void refetch();
    },
  };
}
