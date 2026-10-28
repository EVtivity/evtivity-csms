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
  /**
   * AI Insights are on (`opsAi.enabled` and an insight kind or a background
   * worker job): the nav entry with its pending action count and the
   * dashboard Active insights card.
   */
  aiInsightsEnabled: boolean;
  /**
   * A SIM provider or station signal reads are on: the SIMs nav entry and page,
   * the station Connectivity tab and ICCID field.
   */
  simEnabled: boolean;
}

/** Every flag of `GET /v1/portal/features` the CSMS reads. */
export interface FeatureFlags extends NavFeatureFlags {
  guestChargingEnabled: boolean;
  chatbotAiEnabled: boolean;
  /** Station signal reads are on: a SIM Refresh also sends one OCPP request to the station. */
  simStationSignalEnabled: boolean;
  /**
   * File storage (S3) is set up, so files can be uploaded. Counts as on until
   * the endpoint answers: an upload that finds it off opens the storage dialog.
   */
  fileStorageEnabled: boolean;
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
 * fails), roaming, Plug and Charge, the AI assistant, AI insights and the SIM features count as off and the
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
    aiInsightsEnabled: features?.aiInsightsEnabled === true,
    simEnabled: features?.simEnabled === true,
    simStationSignalEnabled: features?.simStationSignalEnabled === true,
    fileStorageEnabled: features?.fileStorageEnabled !== false,
  };
}

/**
 * The feature toggles from the public `GET /v1/portal/features`, so pages work
 * for users without settings permissions. The key sits under `['settings']`, so
 * a settings save refreshes it. `enabled: false` sends no request (the
 * flags keep their defaults), for a caller that already knows the answer.
 */
export function useFeatureFlags(options: { enabled?: boolean } = {}): FeatureFlagsResult {
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'features'],
    queryFn: () => api.get<FeaturesResponse>('/v1/portal/features'),
    enabled: options.enabled ?? true,
  });
  return { flags: resolveFeatureFlags(data), isLoading, isLoaded: data != null };
}
