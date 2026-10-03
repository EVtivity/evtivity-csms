// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { resolvePriceDisplay, type PriceDisplay } from '@evtivity/lib/price-display';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * The company setting company.priceDisplay, from the public branding settings.
 * Null until the settings have loaded (an error resolves to the default).
 */
export function useCompanyPriceDisplay(): PriceDisplay | null {
  const { data: branding, isError } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });
  if (branding == null && !isError) return null;
  return resolvePriceDisplay(null, branding?.priceDisplay);
}

/**
 * Whether prices are shown including or excluding tax: the signed-in driver's
 * choice, else the company setting (which guests always follow). Null while
 * the company setting is loading and the driver has not chosen, so prices are
 * not shown one way and then switched.
 */
export function usePriceDisplay(): PriceDisplay | null {
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const driverPriceDisplay = useAuth((s) => s.driver?.priceDisplay ?? null);
  const companyPriceDisplay = useCompanyPriceDisplay();
  if (isAuthenticated && driverPriceDisplay != null) return driverPriceDisplay;
  return companyPriceDisplay;
}
