// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Call {
  kind: 'select' | 'update';
  fields?: unknown;
  set?: Record<string, unknown>;
  where?: unknown;
}

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: unknown[][] = [];
  function builder(call: Call): Record<string, unknown> {
    calls.push(call);
    const b: Record<string, unknown> = {
      from: () => b,
      set: (v: Record<string, unknown>) => {
        call.set = v;
        return b;
      },
      where: (w: unknown) => {
        call.where = w;
        return b;
      },
      returning: () => b,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(results.shift() ?? []).then(resolve, reject),
    };
    return b;
  }
  return {
    calls,
    results,
    db: {
      select: (fields?: unknown) => builder({ kind: 'select', fields }),
      selectDistinct: (fields?: unknown) => builder({ kind: 'select', fields }),
      update: () => builder({ kind: 'update' }),
    },
  };
});

vi.mock('@evtivity/database', () => ({
  db: h.db,
  sitePaymentConfigs: {
    id: 'c.id',
    siteId: 'c.site_id',
    payoutAccountId: 'c.payout_account_id',
    payoutAccountStatus: 'c.payout_account_status',
    payoutAccountDetails: 'c.payout_account_details',
    payoutAccountCheckedAt: 'c.payout_account_checked_at',
    updatedAt: 'c.updated_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, value: unknown) => ({ op: 'eq', col, value }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col }),
  lte: (col: unknown, value: unknown) => ({ op: 'lte', col, value }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

import {
  countSitesWithPayoutAccount,
  findSitePayoutAccount,
  payoutAccountIds,
  setPayoutAccountId,
  storeCreatedPayoutAccount,
  writePayoutAccountStatus,
} from '../payout-account-records.js';

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
});

describe('payout account records (P4: payout_account_id plus its stripe_* copy)', () => {
  it('reads the account id from payout_account_id', async () => {
    h.results.push([
      {
        configId: 1,
        siteId: 's1',
        accountId: 'acct_1',
        status: 'active',
        details: null,
        checkedAt: null,
        updatedAt: new Date(),
      },
    ]);
    expect(await findSitePayoutAccount('s1')).toMatchObject({ accountId: 'acct_1' });
    expect(h.calls[0]?.fields).toMatchObject({ accountId: 'c.payout_account_id' });
  });

  it('stores a created account only when the site has none', async () => {
    h.results.push([{ id: 1 }]);
    expect(await storeCreatedPayoutAccount('s1', 'acct_1')).toBe(true);
    const [update] = h.calls;
    expect(update?.set).toMatchObject({
      payoutAccountId: 'acct_1',
      payoutAccountStatus: null,
    });
    expect(update?.where).toEqual({
      op: 'and',
      args: [
        { op: 'eq', col: 'c.site_id', value: 's1' },
        { op: 'isNull', col: 'c.payout_account_id' },
      ],
    });
    expect(await storeCreatedPayoutAccount('s1', 'acct_2')).toBe(false);
  });

  it('sets and clears the account id when it changed', async () => {
    h.results.push([{ id: 1 }]);
    expect(await setPayoutAccountId('s1', 'acct_9')).toBe(true);
    expect(h.calls[0]?.set).toMatchObject({ payoutAccountId: 'acct_9' });
    const where = h.calls[0]?.where as { args: Array<{ values?: unknown[] }> };
    expect(where.args[1]?.values).toEqual(['c.payout_account_id', 'acct_9']);

    h.results.push([{ id: 1 }]);
    expect(await setPayoutAccountId('s1', null)).toBe(true);
    expect(h.calls[1]?.set).toMatchObject({ payoutAccountId: null });
  });

  it('matches status writes, counts and the account list on payout_account_id', async () => {
    h.results.push([{ id: 1 }, { id: 2 }]);
    const status = {
      accountId: 'acct_1',
      state: 'active' as const,
      capabilities: {},
      detailsSubmitted: true,
      requirementsDue: [],
      disabledReason: null,
    };
    expect(await writePayoutAccountStatus(status, new Date())).toBe(2);
    const where = h.calls[0]?.where as { args: unknown[] };
    expect(where.args[0]).toEqual({ op: 'eq', col: 'c.payout_account_id', value: 'acct_1' });

    h.results.push([{ id: 1 }]);
    expect(await countSitesWithPayoutAccount('acct_1')).toBe(1);
    expect(h.calls[1]?.where).toEqual({ op: 'eq', col: 'c.payout_account_id', value: 'acct_1' });

    h.results.push([{ accountId: 'acct_1' }, { accountId: null }]);
    expect(await payoutAccountIds()).toEqual(['acct_1']);
    expect(h.calls[2]?.fields).toEqual({ accountId: 'c.payout_account_id' });
    expect(h.calls[2]?.where).toEqual({ op: 'isNotNull', col: 'c.payout_account_id' });
  });
});
