// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

export function VerifiedRoute(): React.JSX.Element {
  const driver = useAuth((s) => s.driver);

  if (driver != null && !driver.emailVerified) {
    return <Navigate to="/verify-email" replace />;
  }

  return <Outlet />;
}
