// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { usePortalFeatures } from './use-portal-features';

/**
 * Whether drivers can create their own account (portal.registrationEnabled).
 * - `open`: the features say true, the only state that offers sign-up.
 * - `closed`: the features say false; only then does `/register` send the visit to sign-in.
 * - `loading`: the features are still loading.
 * - `error`: the features could not be read, or carry no value.
 * The sign-in link and the register page offer sign-up only while `open`; the
 * API still refuses a registration while it is closed.
 */
export type RegistrationState = 'open' | 'closed' | 'loading' | 'error';

export interface RegistrationStatus {
  state: RegistrationState;
  retry: () => void;
}

export function useRegistrationStatus(): RegistrationStatus {
  const { data, isPending, refetch } = usePortalFeatures();
  const retry = (): void => {
    void refetch();
  };
  if (data?.registrationEnabled === true) return { state: 'open', retry };
  if (data?.registrationEnabled === false) return { state: 'closed', retry };
  if (isPending) return { state: 'loading', retry };
  return { state: 'error', retry };
}
