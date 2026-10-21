// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PASSWORD_POLICY,
  normalizePasswordPolicy,
  type PasswordPolicy,
  type PasswordRule,
} from '@evtivity/lib/password-policy';
import { api } from '@/lib/api';
import { weakPasswordMissing } from '@/lib/password-rules';

// The sign-in pages read the same endpoint under this key, so a page loads it once.
export const SECURITY_PUBLIC_QUERY_KEY = ['security-public'] as const;

function selectPolicy(data: Record<string, unknown>): PasswordPolicy {
  const raw = data['passwordPolicy'];
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
    ? normalizePasswordPolicy(raw as Record<string, unknown>)
    : DEFAULT_PASSWORD_POLICY;
}

/**
 * The password policy an admin set in Settings > Security, from the public security endpoint.
 * The default policy while it loads or when the request fails; the API checks the live one.
 */
export function usePasswordPolicy(): PasswordPolicy {
  const { data, error } = useQuery({
    queryKey: SECURITY_PUBLIC_QUERY_KEY,
    queryFn: () => api.get<Record<string, unknown>>('/v1/security/public?app=portal'),
    staleTime: 60_000,
    select: selectPolicy,
  });
  useEffect(() => {
    if (error != null)
      console.warn('Load the password policy failed, showing the default rules', error);
  }, [error]);
  return data ?? DEFAULT_PASSWORD_POLICY;
}

/**
 * Reads an error from a request that set a password: the rules a WEAK_PASSWORD reply names, or null
 * for any other error. Such a reply can come from a policy newer than the page's, so it also
 * reloads the policy and the rules under the field follow the server.
 */
export function useWeakPasswordReply(): (err: unknown) => PasswordRule[] | null {
  const queryClient = useQueryClient();
  return useCallback(
    (err: unknown) => {
      const missing = weakPasswordMissing(err);
      if (missing != null)
        void queryClient.invalidateQueries({ queryKey: SECURITY_PUBLIC_QUERY_KEY });
      return missing;
    },
    [queryClient],
  );
}
