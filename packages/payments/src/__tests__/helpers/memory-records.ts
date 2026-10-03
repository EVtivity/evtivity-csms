// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomInt } from 'node:crypto';
import type { HoldRecordInput, PaymentRecord } from '../../payment-records.js';
import type { TopUpCharge } from '../../top-ups.js';
import type { PaymentStatus } from '../../types.js';

/** The `metadata.topUps` append of payment-records.ts (skips a listed payment). */
function appendTopUp(
  metadata: unknown,
  topUp: { paymentId: string; amountCents: number },
): Record<string, unknown> {
  const base = { ...((metadata as Record<string, unknown> | null) ?? {}) };
  const list = Array.isArray(base['topUps']) ? (base['topUps'] as TopUpCharge[]) : [];
  if (list.some((t) => t.paymentId === topUp.paymentId)) return base;
  return { ...base, topUps: [...list, { ...topUp, refundedCents: 0 }] };
}

/**
 * An in-memory stand-in for `payment-records.ts` for tests that run the
 * session and refund services against a real provider without a database.
 * It keeps the same from-state guards (P5) and the unique hold per session.
 */
const rows = new Map<number, PaymentRecord>();
// Ids feed idempotency keys (`capture_<id>`), which Stripe keeps for 24 hours,
// so each test file of each run starts from its own random base (two live
// files run in parallel, so a time-based base can collide).
let nextId = randomInt(1, 2 ** 47);
let failCapturedUpdate = false;

function bySession(sessionId: string): PaymentRecord | null {
  for (const row of rows.values()) if (row.sessionId === sessionId) return row;
  return null;
}

function move(
  id: number,
  from: PaymentStatus[],
  changes: Partial<PaymentRecord>,
): PaymentRecord | null {
  const row = rows.get(id);
  if (row == null || !from.includes(row.status)) return null;
  const next = { ...row, ...changes, updatedAt: new Date() };
  rows.set(id, next);
  return next;
}

function insert(
  input: Omit<HoldRecordInput, 'paymentId'> & {
    paymentId: string | null;
    status: PaymentStatus;
    failureReason?: string | null;
  },
): number | null {
  if (bySession(input.sessionId) != null) return null;
  const id = nextId++;
  rows.set(id, {
    id,
    sessionId: input.sessionId,
    driverId: input.driverId,
    sitePaymentConfigId: input.sitePaymentConfigId,
    stripePaymentIntentId: input.paymentId,
    stripeCustomerId: input.customerId,
    stripePaymentMethodId: input.methodId,
    paymentSource: input.source,
    currency: input.currency,
    preAuthAmountCents: input.preAuthAmountCents,
    capturedAmountCents: null,
    refundedAmountCents: 0,
    status: input.status,
    failureReason: input.failureReason ?? null,
    lastActorUserId: null,
    lastActionReason: null,
    metadata: null,
    chargeType: 'session',
    reservationId: null,
    taxRate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

export const records = {
  recordHold: (input: HoldRecordInput) =>
    Promise.resolve(insert({ ...input, status: 'pre_authorized' })),
  recordFailedHold: (
    input: Omit<HoldRecordInput, 'paymentId' | 'preAuthAmountCents'> & {
      preAuthAmountCents: number | null;
      reason: string;
    },
  ) =>
    Promise.resolve(
      insert({
        ...input,
        paymentId: null,
        preAuthAmountCents: input.preAuthAmountCents ?? 0,
        status: 'failed',
        failureReason: input.reason,
      }),
    ),
  findRecord: (id: number) => Promise.resolve(rows.get(id) ?? null),
  findSessionRecord: (sessionId: string) => Promise.resolve(bySession(sessionId)),
  findSessionHold: (sessionId: string) => {
    const row = bySession(sessionId);
    return Promise.resolve(row?.status === 'pre_authorized' ? row : null);
  },
  markCaptured: (
    id: number,
    input: {
      capturedCents: number;
      failureReason: string | null;
      topUp?: { paymentId: string; amountCents: number } | null;
    },
  ) => {
    if (failCapturedUpdate) {
      failCapturedUpdate = false;
      return Promise.reject(new Error('simulated database failure'));
    }
    const row = rows.get(id);
    const topUp = input.topUp ?? null;
    return Promise.resolve(
      move(id, ['pre_authorized'], {
        status: 'captured',
        capturedAmountCents: input.capturedCents,
        failureReason: input.failureReason,
        ...(topUp != null && row != null ? { metadata: appendTopUp(row.metadata, topUp) } : {}),
      }) != null,
    );
  },
  markCancelled: (id: number) =>
    Promise.resolve(
      move(id, ['pre_authorized'], { status: 'cancelled', capturedAmountCents: 0 }) != null,
    ),
  markHoldFailed: (id: number, reason: string) =>
    Promise.resolve(
      move(id, ['pre_authorized'], { status: 'failed', failureReason: reason }) != null,
    ),
  markShortfallRecovered: (
    id: number,
    input: { capturedCents: number; topUp: { paymentId: string; amountCents: number } },
  ) =>
    Promise.resolve(
      move(id, ['captured'], {
        capturedAmountCents: input.capturedCents,
        failureReason: null,
        metadata: appendTopUp(rows.get(id)?.metadata ?? null, input.topUp),
      }),
    ),
  markShortfallRetryFailed: (id: number, reason: string) =>
    Promise.resolve(move(id, ['captured'], { failureReason: reason }) != null),
  settlePrepaidSession: () => Promise.resolve(null),
  lockSessionRecord: (_tx: unknown, sessionId: string) => Promise.resolve(bySession(sessionId)),
  markRefunded: (
    id: number,
    input: { refundedTotalCents: number; full: boolean; topUps?: TopUpCharge[] },
  ) => {
    const row = rows.get(id);
    if (row == null || input.refundedTotalCents < row.refundedAmountCents) {
      return Promise.resolve(null);
    }
    const metadata = { ...((row.metadata as Record<string, unknown> | null) ?? {}) };
    if (input.topUps != null) {
      delete metadata['topUpIntentId'];
      metadata['topUps'] = input.topUps;
    }
    return Promise.resolve(
      move(id, ['captured', 'partially_refunded'], {
        status: input.full ? 'refunded' : 'partially_refunded',
        refundedAmountCents: input.refundedTotalCents,
        ...(input.topUps != null ? { metadata } : {}),
      }),
    );
  },
};

export const memoryRecords = {
  bySession,
  /** The next markCaptured throws, as when the provider charged but the database is down. */
  failNextCapturedUpdate(): void {
    failCapturedUpdate = true;
  },
};
