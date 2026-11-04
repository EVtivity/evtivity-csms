// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { executeRecaptcha } from '@/lib/recaptcha';
import { SECURITY_PUBLIC_QUERY_KEY } from '@/hooks/use-password-policy';

/** The reCAPTCHA action a form runs; the API checks it against the siteverify reply. */
export type RecaptchaAction = 'login';

interface RecaptchaConfig {
  recaptchaEnabled: boolean;
  recaptchaSiteKey: string;
}

const fetchConfig = (): Promise<RecaptchaConfig> => api.get<RecaptchaConfig>('/v1/security/public');

export interface RecaptchaToken {
  /** True until `GET /v1/security/public` answers or fails. Forms keep their submit disabled meanwhile. */
  configPending: boolean;
  /**
   * The token of the action when reCAPTCHA is on, run at submit time. A submit that comes before
   * the config answers waits for it. Undefined when reCAPTCHA is off, or when the config cannot be
   * loaded: the API then refuses a request that needs a token (fail closed) and the form shows
   * that error.
   */
  getToken: (action: RecaptchaAction) => Promise<string | undefined>;
}

/** The reCAPTCHA gate of a public form, on the public security config the sign-in pages share. */
export function useRecaptchaToken(): RecaptchaToken {
  const queryClient = useQueryClient();
  const { isPending, error } = useQuery({
    queryKey: SECURITY_PUBLIC_QUERY_KEY,
    queryFn: fetchConfig,
  });
  useEffect(() => {
    if (error != null) console.warn('Load the reCAPTCHA config failed', error);
  }, [error]);

  const getToken = useCallback(
    async (action: RecaptchaAction): Promise<string | undefined> => {
      let config = queryClient.getQueryData<RecaptchaConfig>(SECURITY_PUBLIC_QUERY_KEY);
      if (config == null) {
        try {
          // Joins the request in flight, or asks again after a failed one.
          config = await queryClient.fetchQuery({
            queryKey: SECURITY_PUBLIC_QUERY_KEY,
            queryFn: fetchConfig,
          });
        } catch (err) {
          console.warn('Load the reCAPTCHA config failed, sending no token', err);
          return undefined;
        }
      }
      if (config?.recaptchaEnabled !== true || config.recaptchaSiteKey === '') return undefined;
      return executeRecaptcha(config.recaptchaSiteKey, action);
    },
    [queryClient],
  );

  return { configPending: isPending, getToken };
}
