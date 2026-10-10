// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Shared steps of the tariff and cost tests (module I): the station's local
// cost device model, the idle grace setting, and the session the CSMS records
// a transaction under.

import type { TestContext } from './types.js';
import { CSMS_STATE_TIMEOUT_MS } from './security-test-helpers.js';

/** What the CSMS uses without an `idling.gracePeriodMinutes` number (its reader's default). */
const DEFAULT_GRACE_MINUTES = 30;

/**
 * The idle grace in seconds as the CSMS sends it (TariffConditionsType.minIdleTime):
 * the `idling.gracePeriodMinutes` setting, read through the API when the run
 * has an API key, else its default.
 */
export async function idleGraceSeconds(ctx: TestContext): Promise<number> {
  if (ctx.callApi == null) return DEFAULT_GRACE_MINUTES * 60;
  const res = await ctx.callApi('GET', '/settings/idling.gracePeriodMinutes');
  const value = res.body['value'];
  return res.status === 200 && typeof value === 'number' && value >= 0
    ? Math.round(value * 60)
    : DEFAULT_GRACE_MINUTES * 60;
}

/**
 * Reports the station's local cost calculation in its device model with an
 * unsolicited NotifyReport: TariffCostCtrlr.Enabled[Tariff] true and
 * ConditionsSupported[Tariff] as given. Waits until the CSMS stored it (when
 * the run has an API key). Returns null, or why the wait failed.
 */
export async function reportLocalCostSupport(
  ctx: TestContext,
  conditionsSupported: boolean,
): Promise<string | null> {
  const variable = (name: string, value: string) => ({
    component: { name: 'TariffCostCtrlr' },
    variable: { name, instance: 'Tariff' },
    variableAttribute: [{ type: 'Actual', value }],
  });
  await ctx.client.sendCall('NotifyReport', {
    requestId: 0,
    generatedAt: new Date().toISOString(),
    seqNo: 0,
    tbc: false,
    reportData: [
      variable('Enabled', 'true'),
      variable('ConditionsSupported', conditionsSupported ? 'true' : 'false'),
    ],
  });
  if (ctx.callApi == null || ctx.stationDbId == null) return null;
  const deadline = Date.now() + CSMS_STATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await ctx.callApi(
      'GET',
      `/stations/${ctx.stationDbId}/variables?search=ConditionsSupported&limit=10`,
    );
    const rows = (res.body['data'] as Array<Record<string, unknown>> | undefined) ?? [];
    if (rows.some((r) => r['component'] === 'TariffCostCtrlr')) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return 'TariffCostCtrlr not stored by the CSMS in time';
}

/**
 * The CSMS session of a transaction (GET /v1/sessions/:id), polled until
 * `ready` accepts it. Null without an API key or when it does not get there.
 */
export async function waitForSession(
  ctx: TestContext,
  transactionId: string,
  ready: (session: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  if (ctx.callApi == null || ctx.stationDbId == null) return null;
  const deadline = Date.now() + CSMS_STATE_TIMEOUT_MS;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const list = await ctx.callApi('GET', `/stations/${ctx.stationDbId}/sessions?limit=50`);
    const rows = (list.body['data'] as Array<Record<string, unknown>> | undefined) ?? [];
    const row = rows.find((r) => r['transactionId'] === transactionId);
    if (row != null) {
      const detail = await ctx.callApi('GET', `/sessions/${String(row['id'])}`);
      last = detail.body;
      if (ready(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last != null && ready(last) ? last : null;
}

/** The price elements of a TariffType field (energy, chargingTime, ...). */
export function tariffPrices(
  tariff: Record<string, unknown> | undefined,
  field: string,
): Array<Record<string, unknown>> {
  const section = tariff?.[field] as Record<string, unknown> | undefined;
  return (section?.['prices'] as Array<Record<string, unknown>> | undefined) ?? [];
}

/** The conditions of a price element, {} without. */
export function conditionsOf(price: Record<string, unknown> | undefined): Record<string, unknown> {
  return (price?.['conditions'] as Record<string, unknown> | undefined) ?? {};
}
