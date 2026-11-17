// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Navigate, useLocation } from 'react-router';
import { useIsFleetUser } from '@/lib/auth';

/**
 * The pages a fleet user reaches: the Dashboard (its fleet cards and charts),
 * the fleet list, a fleet page, a fleet invoice (opened from the Billing tab or
 * the Dashboard), the own profile and Settings, where it sees only its API Keys tab. The API answers 404 for everything else, so
 * those pages would only show errors.
 */
export function fleetUserPathAllowed(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/' || path === '/fleets' || path === '/profile' || path === '/settings')
    return true;
  const fleet = /^\/fleets\/([^/]+)$/.exec(path);
  if (fleet != null) return fleet[1] !== 'new';
  return /^\/invoices\/[^/]+$/.test(path);
}

interface FleetUserRouteProps {
  children: React.ReactNode;
}

/** Sends a fleet user from any other page to its Dashboard. */
export function FleetUserRoute({ children }: FleetUserRouteProps): React.JSX.Element {
  const isFleetUser = useIsFleetUser();
  const location = useLocation();

  if (isFleetUser && !fleetUserPathAllowed(location.pathname)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
