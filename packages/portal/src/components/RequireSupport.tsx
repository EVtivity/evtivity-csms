// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Navigate, Outlet } from 'react-router';
import { useSupportEnabled } from '@/hooks/use-support-enabled';

/**
 * Guards the support pages: with support turned off a direct visit goes back
 * home instead of showing a form whose submit fails with SUPPORT_DISABLED.
 */
export function RequireSupport(): React.JSX.Element {
  const supportEnabled = useSupportEnabled();
  if (supportEnabled === false) return <Navigate to="/" replace />;
  return <Outlet />;
}
