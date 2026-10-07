// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { idTagInfoFor } from '../../../handlers/v1_6/id-tag-info.js';
import type { AuthorizeDecision } from '../../../authorization/authorize-context.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');

function decision(fields: Partial<AuthorizeDecision>): AuthorizeDecision {
  return {
    status: 'accepted',
    outcome: 'accepted',
    reason: null,
    source: 'driver_token',
    matchedTokenId: 'tok-1',
    matchedDriverId: 'drv-1',
    expiresAt: null,
    prepaid: false,
    prepaidBalanceCents: null,
    echoGroupId: false,
    ...fields,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('idTagInfoFor', () => {
  it.each([
    ['accepted', 'Accepted'],
    ['blocked', 'Blocked'],
    ['expired', 'Expired'],
    ['invalid', 'Invalid'],
    ['no_credit', 'Blocked'],
    ['concurrent_tx', 'ConcurrentTx'],
  ] as const)('maps %s to %s', (status, expected) => {
    expect(idTagInfoFor(decision({ status }))).toEqual({ status: expected });
  });

  it('sends the expiry of an accepted token', () => {
    expect(idTagInfoFor(decision({ expiresAt: FUTURE }))).toEqual({
      status: 'Accepted',
      expiryDate: FUTURE.toISOString(),
    });
  });

  it('does not send the expiry of a rejected token', () => {
    expect(idTagInfoFor(decision({ status: 'concurrent_tx', expiresAt: FUTURE }))).toEqual({
      status: 'ConcurrentTx',
    });
  });

  it.each(['accepted', 'no_credit'] as const)('expires a prepaid %s token now', (status) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    expect(idTagInfoFor(decision({ status, prepaid: true, expiresAt: FUTURE }))).toEqual({
      status: status === 'accepted' ? 'Accepted' : 'Blocked',
      expiryDate: NOW.toISOString(),
    });
  });
});
