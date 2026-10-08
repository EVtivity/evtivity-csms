// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  calls: [] as { text: string; values: unknown[] }[],
}));

vi.mock('@evtivity/database', () => ({
  client: (strings: TemplateStringsArray, ...values: unknown[]) => {
    h.calls.push({ text: strings.join('?'), values });
    return Promise.resolve(h.rows);
  },
}));

const { prepaidSessionCeilingCents } = await import('../../handlers/prepaid-session-limit.js');

describe('prepaidSessionCeilingCents', () => {
  beforeEach(() => {
    h.rows = [];
    h.calls = [];
  });

  it('returns the ceiling of the session linked to the token', async () => {
    h.rows = [{ cost_ceiling_cents: 600 }];
    await expect(prepaidSessionCeilingCents('CS-1', 'tx-1', 'tok-1')).resolves.toBe(600);
    expect(h.calls[0]?.values).toEqual(['CS-1', 'tx-1', 'tok-1']);
    expect(h.calls[0]?.text).toContain('cs.token_id =');
  });

  it('returns 0 for a session without credit', async () => {
    h.rows = [{ cost_ceiling_cents: '0' }];
    await expect(prepaidSessionCeilingCents('CS-1', 'tx-1', 'tok-1')).resolves.toBe(0);
  });

  it('returns null when the session is not linked or has no ceiling', async () => {
    await expect(prepaidSessionCeilingCents('CS-1', 'tx-1', 'tok-1')).resolves.toBeNull();
    h.rows = [{ cost_ceiling_cents: null }];
    await expect(prepaidSessionCeilingCents('CS-1', 'tx-1', 'tok-1')).resolves.toBeNull();
  });
});
