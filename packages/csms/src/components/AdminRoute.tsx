// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Navigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

interface AdminRouteProps {
  children: React.ReactNode;
  requiredPermission?: string;
}

function hasPermCheck(userPermissions: string[], required: string): boolean {
  if (userPermissions.includes(required)) return true;
  if (required.endsWith(':read')) {
    const writeVersion = required.replace(':read', ':write');
    if (userPermissions.includes(writeVersion)) return true;
  }
  return false;
}

export function AdminRoute({ children, requiredPermission }: AdminRouteProps): React.JSX.Element {
  const permissions = useAuth((s) => s.permissions);

  if (requiredPermission != null && !hasPermCheck(permissions, requiredPermission)) {
    return <Navigate to="/" replace />;
  }

  // When no specific permission is required, check if user has any settings permission
  // (used for the Settings route)
  if (requiredPermission == null) {
    const hasAnySettings = permissions.some((p) => p.startsWith('settings.'));
    if (!hasAnySettings) {
      return <Navigate to="/" replace />;
    }
  }

  return <>{children}</>;
}
