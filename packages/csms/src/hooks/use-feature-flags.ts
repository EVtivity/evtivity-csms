// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** The feature toggles that hide nav entries. */
export interface NavFeatureFlags {
  roamingEnabled: boolean;
  pncEnabled: boolean;
  reservationEnabled: boolean;
  supportEnabled: boolean;
  fleetEnabled: boolean;
}

/** Every flag of `GET /v1/portal/features` the CSMS reads. */
export interface FeatureFlags extends NavFeatureFlags {
  guestChargingEnabled: boolean;
  chatbotAiEnabled: boolean;
}

export interface FeatureFlagsResult {
  flags: FeatureFlags;
  /** True until the first answer or failure. */
  isLoading: boolean;
  /** True once the endpoint answered. */
  isLoaded: boolean;
}

type FeaturesResponse = Partial<Record<keyof FeatureFlags, unknown>>;

/**
 * The flags from `GET /v1/portal/features`. Until it answers (or when it
 * fails), roaming, Plug and Charge and the AI assistant count as off and the
 * others as on.
 */
export function resolveFeatureFlags(features: FeaturesResponse | undefined): FeatureFlags {
  return {
    roamingEnabled: features?.roamingEnabled === true,
    pncEnabled: features?.pncEnabled === true,
    reservationEnabled: features?.reservationEnabled !== false,
    supportEnabled: features?.supportEnabled !== false,
    fleetEnabled: features?.fleetEnabled !== false,
    guestChargingEnabled: features?.guestChargingEnabled !== false,
    chatbotAiEnabled: features?.chatbotAiEnabled === true,
  };
}

/**
 * The feature toggles from the public `GET /v1/portal/features`, so pages work
 * for users without settings permissions. The key sits under `['settings']`, so
 * a settings save refreshes it.
 */
export function useFeatureFlags(): FeatureFlagsResult {
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'features'],
    queryFn: () => api.get<FeaturesResponse>('/v1/portal/features'),
  });
  return { flags: resolveFeatureFlags(data), isLoading, isLoaded: data != null };
}
