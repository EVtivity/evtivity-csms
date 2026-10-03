// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Stand-ins for `@evtivity/database` and `../settings.js` for tests that run
 * the session and refund services against a real provider without a
 * database (payment records come from `memory-records.ts`). The session,
 * method and site-config reads answer from `sessionDb`. Use with:
 *
 *   vi.mock('@evtivity/database', async () => (await import('./helpers/session-db.js')).databaseMock);
 *   vi.mock('../settings.js', async () => (await import('./helpers/session-db.js')).settingsMock);
 */

export interface SessionScenario {
  sessionId: string;
  finalCostCents: number | null;
  siteId: string;
}

export const sessionDb = {
  current: null as SessionScenario | null,
  method: null as { id: number; customerId: string; methodId: string } | null,
  sitePaymentConfig: null as {
    configId: number;
    payoutAccountId: string | null;
    preAuthAmountCents: number;
  } | null,
  platformFeePercent: 0,
};

// Answers each service query by the fields it selects.
function select(fields: Record<string, unknown>): Record<string, unknown> {
  const rows = (): unknown[] => {
    const s = sessionDb.current;
    if ('methodId' in fields) return sessionDb.method != null ? [sessionDb.method] : [];
    if (s == null) return [];
    if ('currency' in fields) return [{ currency: 'USD' }];
    const charge = {
      finalCostCents: s.finalCostCents,
      tariffTaxRate: '0.19',
      costBreakdown: null,
      siteId: s.siteId,
    };
    if ('prepaid' in fields) {
      return [
        {
          ...charge,
          id: s.sessionId,
          driverId: 'd1',
          isRoaming: false,
          freeVend: false,
          prepaid: false,
        },
      ];
    }
    return [charge];
  };
  const b: Record<string, unknown> = {
    from: () => b,
    innerJoin: () => b,
    leftJoin: () => b,
    where: () => b,
    limit: () => b,
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(resolve, reject),
  };
  return b;
}

export const databaseMock = {
  db: {
    select,
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  },
  chargingSessions: {
    id: 'cs.id',
    currency: 'cs.currency',
    stationId: 'cs.station_id',
    finalCostCents: 'cs.final_cost_cents',
    tariffTaxRate: 'cs.tariff_tax_rate',
    costBreakdown: 'cs.cost_breakdown',
    tokenId: 'cs.token_id',
    driverId: 'cs.driver_id',
    isRoaming: 'cs.is_roaming',
    freeVend: 'cs.free_vend',
  },
  chargingStations: { id: 'st.id', siteId: 'st.site_id' },
  driverTokens: { id: 't.id', prepaidBalanceCents: 't.prepaid_balance_cents' },
  driverPaymentMethods: {
    id: 'm.id',
    driverId: 'm.driver_id',
    isDefault: 'm.is_default',
    stripeCustomerId: 'm.stripe_customer_id',
    stripePaymentMethodId: 'm.stripe_payment_method_id',
  },
  getPlatformFeePercent: () => Promise.resolve(sessionDb.platformFeePercent),
};

export const settingsMock = {
  getSitePaymentConfig: () => Promise.resolve(sessionDb.sitePaymentConfig),
};
