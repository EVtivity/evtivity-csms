// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { resolveTaxBasis, type TaxBasis } from '@evtivity/lib/price-display';
import { api } from '@/lib/api';

/**
 * How tariff prices are entered (`company.taxBasis`): excluding ('net') or
 * including ('gross') tax. Read from the public branding endpoint (query key
 * `['branding']`, shared with useCompanyCurrency). Undefined while loading;
 * an unset or invalid value resolves to the default, as on the server.
 */
export function useCompanyTaxBasis(): TaxBasis | undefined {
  const { data: branding, isError } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });
  if (branding == null && !isError) return undefined;
  return resolveTaxBasis(branding?.['taxBasis']);
}
