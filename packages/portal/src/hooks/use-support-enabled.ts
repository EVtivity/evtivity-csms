// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { usePortalFeatures } from './use-portal-features';

/**
 * Whether drivers can open support cases (support.enabled). Undefined while
 * the features load or when they cannot be read; callers treat only an
 * explicit false as disabled, as the nav and home cards do.
 */
export function useSupportEnabled(): boolean | undefined {
  const { data } = usePortalFeatures();
  return data?.supportEnabled;
}
