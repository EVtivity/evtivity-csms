// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import type { TestContext } from './types.js';
import { waitForOnline } from './security-test-helpers.js';

/** A unique PSP reference for one test, as a payment provider would issue it. */
export function newPspRef(): string {
  return `OCTT-PSP-${randomBytes(6).toString('hex').toUpperCase()}`;
}

export interface AdHocPaymentRequest {
  pspRef: string;
  evseId: number;
  cardLast4Digits?: string;
  cardBin?: string;
  maxCostCents?: number;
  maxEnergyWh?: number;
  maxTimeSeconds?: number;
}

/**
 * Performs the OCTT manual action of the ad hoc payment tests (C24 payment
 * terminal, C25 QR code): the payment terminal or payment provider reports an
 * authorized payment to the CSMS (POST /v1/ad-hoc-payments), which then sends
 * RequestStartTransaction. The CSMS records the station's connection and its
 * EVSEs asynchronously after boot, so the call waits for the station to be
 * online and retries while the EVSE is not known yet (a retry with the same
 * pspRef is idempotent). Returns an error description, or null on success.
 */
export async function requestAdHocPayment(
  ctx: TestContext,
  payment: AdHocPaymentRequest,
  timeoutMs = 10_000,
): Promise<string | null> {
  if (ctx.callApi == null) return 'API client not available';
  if (!(await waitForOnline(ctx, timeoutMs))) return 'Station not online in the CSMS';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ctx.callApi('POST', '/ad-hoc-payments', {
      stationId: ctx.stationId,
      ...payment,
    });
    if (res.status === 200) return null;
    const code = typeof res.body['code'] === 'string' ? res.body['code'] : '';
    if (code !== 'EVSE_NOT_FOUND' || Date.now() >= deadline) {
      return `HTTP ${String(res.status)} ${code}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Configures the CSMS to limit the cost of transactions started with
 * `idToken`: the operator sets the token's prepaid credit (PATCH /v1/tokens),
 * which the CSMS returns as transactionLimit.maxCost (C17.FR.03). Returns an
 * error description, or null on success.
 */
export async function setTokenCostLimit(
  ctx: TestContext,
  idToken: string,
  maxCostCents: number,
): Promise<string | null> {
  if (ctx.callApi == null) return 'API client not available';
  const list = await ctx.callApi('GET', `/tokens?search=${encodeURIComponent(idToken)}&limit=10`);
  if (list.status !== 200) return `Token lookup HTTP ${String(list.status)}`;
  const rows = (list.body['data'] as Array<Record<string, unknown>> | undefined) ?? [];
  const token = rows.find((row) => row['idToken'] === idToken);
  if (token == null || typeof token['id'] !== 'string') return `Token ${idToken} not found`;
  const res = await ctx.callApi('PATCH', `/tokens/${token['id']}`, {
    prepaidBalanceCents: maxCostCents,
  });
  return res.status === 200 ? null : `Token update HTTP ${String(res.status)}`;
}
