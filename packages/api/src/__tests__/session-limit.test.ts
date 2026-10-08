// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queries: string[] = [];
let rows: Array<{ trigger_reason: string | null }> = [];

vi.mock('@evtivity/database', () => ({
  client: (strings: TemplateStringsArray) => {
    queries.push(strings.join('?'));
    return Promise.resolve(rows);
  },
}));

const { sessionLimitReached } = await import('../lib/session-limit.js');

describe('sessionLimitReached', () => {
  beforeEach(() => {
    queries.length = 0;
    rows = [];
  });

  it('maps the reported trigger reason to the limit', async () => {
    rows = [{ trigger_reason: 'CostLimitReached' }];
    expect(await sessionLimitReached('s1')).toBe('cost');
    rows = [{ trigger_reason: 'EnergyLimitReached' }];
    expect(await sessionLimitReached('s1')).toBe('energy');
    rows = [{ trigger_reason: 'TimeLimitReached' }];
    expect(await sessionLimitReached('s1')).toBe('time');
  });

  it('returns null without a limit', async () => {
    rows = [{ trigger_reason: null }];
    expect(await sessionLimitReached('s1')).toBeNull();
    rows = [];
    expect(await sessionLimitReached('s1')).toBeNull();
  });

  it('reports the cost limit for a session stopped at its guest hold or prepaid credit', async () => {
    rows = [{ trigger_reason: null }];
    await sessionLimitReached('s1');
    expect(queries[0]).toContain(
      "stopped_reason IN ('GuestHoldExhausted', 'PrepaidCreditExhausted')",
    );
  });

  it('reports the cost limit for an account session stopped at its fleet credit, not a refused start', async () => {
    rows = [{ trigger_reason: 'CostLimitReached' }];
    expect(await sessionLimitReached('s1')).toBe('cost');
    expect(queries[0]).toContain("stopped_reason = 'AccountCreditLimit' AND status <> 'faulted'");
  });
});
