// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { AuthorizationStatusEnum } from '../../generated/v2_1/enums/AuthorizationStatusEnum.js';
import type { IdTokenType } from '../../generated/v2_1/types/common/IdTokenType.js';
import type { AuthorizeDecision, AuthorizeStatus } from '../../authorization/authorize-context.js';

const STATUS: Record<AuthorizeStatus, AuthorizationStatusEnum> = {
  accepted: 'Accepted',
  blocked: 'Blocked',
  expired: 'Expired',
  invalid: 'Invalid',
  no_credit: 'NoCredit',
  concurrent_tx: 'ConcurrentTx',
};

/** The 2.1 AuthorizationStatusEnum for an authorize decision. */
export function idTokenStatusFor(decision: AuthorizeDecision): AuthorizationStatusEnum {
  return STATUS[decision.status];
}

/** The groupIdToken the response echoes (the token itself), when the decision echoes one. */
export function groupIdTokenFor(
  decision: AuthorizeDecision,
  idToken: string,
  type: string,
): IdTokenType | undefined {
  return decision.echoGroupId ? { idToken, type } : undefined;
}
