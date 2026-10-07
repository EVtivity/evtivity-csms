// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { IdTagInfoType } from '../../generated/v1_6/types/common/IdTagInfoType.js';
import type { AuthorizeDecision, AuthorizeStatus } from '../../authorization/authorize-context.js';

// OCPP 1.6 has no NoCredit status: a prepaid idTag without credit is Blocked.
const STATUS: Record<
  AuthorizeStatus,
  'Accepted' | 'Blocked' | 'Expired' | 'Invalid' | 'ConcurrentTx'
> = {
  accepted: 'Accepted',
  blocked: 'Blocked',
  expired: 'Expired',
  invalid: 'Invalid',
  no_credit: 'Blocked',
  concurrent_tx: 'ConcurrentTx',
};

/**
 * The 1.6 idTagInfo for an authorize decision (Authorize and StartTransaction).
 * A prepaid idTag expires from the station's authorization cache at once
 * (expiryDate = now), so every start asks the CSMS for the current balance.
 * An accepted token with an expiry sends it.
 */
export function idTagInfoFor(decision: AuthorizeDecision): IdTagInfoType {
  const idTagInfo: IdTagInfoType = { status: STATUS[decision.status] };
  if (decision.prepaid) {
    idTagInfo.expiryDate = new Date().toISOString();
  } else if (decision.status === 'accepted' && decision.expiresAt != null) {
    idTagInfo.expiryDate = decision.expiresAt.toISOString();
  }
  return idTagInfo;
}
