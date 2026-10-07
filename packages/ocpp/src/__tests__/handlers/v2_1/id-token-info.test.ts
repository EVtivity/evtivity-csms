// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { groupIdTokenFor, idTokenStatusFor } from '../../../handlers/v2_1/id-token-info.js';
import type { AuthorizeDecision } from '../../../authorization/authorize-context.js';

function decision(fields: Partial<AuthorizeDecision>): AuthorizeDecision {
  return {
    status: 'accepted',
    outcome: 'accepted',
    reason: null,
    source: 'driver_token',
    matchedTokenId: null,
    matchedDriverId: null,
    expiresAt: null,
    prepaid: false,
    prepaidBalanceCents: null,
    echoGroupId: false,
    ...fields,
  };
}

describe('idTokenStatusFor', () => {
  it.each([
    ['accepted', 'Accepted'],
    ['blocked', 'Blocked'],
    ['expired', 'Expired'],
    ['invalid', 'Invalid'],
    ['no_credit', 'NoCredit'],
    ['concurrent_tx', 'ConcurrentTx'],
  ] as const)('maps %s to %s', (status, expected) => {
    expect(idTokenStatusFor(decision({ status }))).toBe(expected);
  });
});

describe('groupIdTokenFor', () => {
  it('echoes the token when the decision echoes it', () => {
    expect(groupIdTokenFor(decision({ echoGroupId: true }), 'TAG', 'ISO14443')).toEqual({
      idToken: 'TAG',
      type: 'ISO14443',
    });
  });

  it('omits it otherwise', () => {
    expect(groupIdTokenFor(decision({}), 'TAG', 'ISO14443')).toBeUndefined();
  });
});
