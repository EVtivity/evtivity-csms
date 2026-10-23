// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback } from 'react';
import {
  ocppCommandPayloadPermission,
  ocppCommandRoutePermissions,
} from '@evtivity/lib/ocpp-command-permissions';
import { hasPermissionCheck, useAuth } from '@/lib/auth';

/**
 * Whether the current user may send a station command: `stations:write` plus
 * the feature permission of the action, and `certificates:write` for a
 * certificate signing trigger (the API's map). Controls
 * that would only answer 403 are hidden with it.
 */
export function useCanSendOcppCommand(): (
  action: string,
  payload?: Record<string, unknown>,
) => boolean {
  const permissions = useAuth((s) => s.permissions);
  return useCallback(
    (action: string, payload: Record<string, unknown> = {}) => {
      const required = [...ocppCommandRoutePermissions(action)];
      const extra = ocppCommandPayloadPermission(action, payload);
      if (extra != null) required.push(extra);
      return required.every((perm) => hasPermissionCheck(permissions, perm));
    },
    [permissions],
  );
}
