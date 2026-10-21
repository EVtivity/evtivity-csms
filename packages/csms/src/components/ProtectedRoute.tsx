// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/lib/auth';
import { loginPathFor, takeReturnTo } from '@/lib/return-to';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * Sends a signed-out user to the sign-in page with the page they asked for
 * as `returnTo`. After an SSO login (which comes back to `/`), the
 * remembered page opens once. After Log Out the sign-in page gets no
 * `returnTo`, so the next sign-in opens the dashboard.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps): React.JSX.Element | null {
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const isHydrating = useAuth((s) => s.isHydrating);
  const signedOut = useAuth((s) => s.signedOut);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (isHydrating || !isAuthenticated) return;
    const target = takeReturnTo();
    if (target != null && target !== `${location.pathname}${location.search}${location.hash}`) {
      void navigate(target, { replace: true });
    }
    // Only when the session starts, not on every page change.
  }, [isAuthenticated, isHydrating]);

  if (isHydrating) {
    return null;
  }

  if (!isAuthenticated) {
    return (
      <Navigate
        to={
          signedOut
            ? '/login'
            : loginPathFor(`${location.pathname}${location.search}${location.hash}`)
        }
        replace
      />
    );
  }

  return <>{children}</>;
}
