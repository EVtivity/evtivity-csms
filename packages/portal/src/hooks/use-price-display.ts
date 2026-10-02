// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { resolvePriceDisplay, type PriceDisplay } from '@evtivity/lib/price-display';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** The company setting company.priceDisplay, from the public branding settings. */
export function useCompanyPriceDisplay(): PriceDisplay {
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });
  return resolvePriceDisplay(null, branding?.priceDisplay);
}

/**
 * Whether prices are shown including or excluding tax: the driver's choice,
 * else the company setting. Guests always see prices including tax.
 */
export function usePriceDisplay(): PriceDisplay {
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const driverPriceDisplay = useAuth((s) => s.driver?.priceDisplay ?? null);
  const companyPriceDisplay = useCompanyPriceDisplay();
  if (!isAuthenticated) return 'gross';
  return driverPriceDisplay ?? companyPriceDisplay;
}
