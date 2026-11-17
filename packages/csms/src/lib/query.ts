// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { getApiErrorCode } from './api';

/** The key of `GET /v1/portal/features` (`useFeatureFlags`). */
const FEATURES_QUERY_KEY = ['settings', 'features'] as const;

/**
 * A 403 FLEET_DISABLED means the Fleets feature was turned off since the flags
 * loaded: read them again, so the pages that depend on it (a fleet user's
 * Fleets off page) follow at once.
 */
function refreshFlagsOnFleetsOff(err: unknown): void {
  const code = getApiErrorCode(err);
  if (code === 'FLEET_USER_NO_FLEETS') {
    // The fleet user's last fleet went away: read its fleets again, so the
    // No Fleets page shows at once. Loaded on use: auth.ts imports this module.
    void import('./auth').then(({ useAuth }) => useAuth.getState().refreshAccess());
    return;
  }
  if (code !== 'FLEET_DISABLED') return;
  void queryClient.invalidateQueries({ queryKey: FEATURES_QUERY_KEY });
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: refreshFlagsOnFleetsOff }),
  mutationCache: new MutationCache({ onError: refreshFlagsOnFleetsOff }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
