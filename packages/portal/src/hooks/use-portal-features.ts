// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** The one cache key of GET /v1/portal/features; invalidate through it. */
export const PORTAL_FEATURES_QUERY_KEY = ['portal-features'] as const;

/** How long one features read serves every reader. */
export const PORTAL_FEATURES_STALE_TIME_MS = 60_000;

/**
 * The public feature flags of GET /v1/portal/features that the portal reads.
 * Every field is optional: an older API may not send one, and each reader
 * keeps its own default for a missing value.
 */
export interface PortalFeatures {
  reservationEnabled?: boolean;
  supportEnabled?: boolean;
  /** False: the operator manages the RFID cards and every driver change is refused. */
  rfidSelfServiceEnabled?: boolean;
  registrationEnabled?: boolean;
  autochargeEnabled?: boolean;
  driverAiSupport?: boolean;
  driverAiNoticeVersion?: number;
  reservationCancellationWindowMinutes?: number;
  reservationMaxHours?: number;
  currency?: string;
  avatarUploadEnabled?: boolean;
  /** OCPI roaming is on (roaming.enabled): the charger search offers the Partner Network tab. */
  roamingEnabled?: boolean;
}

/** The portal feature flags, one cached request shared by every reader. */
export function usePortalFeatures(options?: { enabled?: boolean }): UseQueryResult<PortalFeatures> {
  return useQuery({
    queryKey: PORTAL_FEATURES_QUERY_KEY,
    queryFn: () => api.get<PortalFeatures>('/v1/portal/features'),
    staleTime: PORTAL_FEATURES_STALE_TIME_MS,
    enabled: options?.enabled ?? true,
  });
}
