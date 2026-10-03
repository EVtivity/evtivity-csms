// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { SIMULATED_SCENARIOS } from './test-cards.js';
import type { SimulatedScenario } from './test-cards.js';

/**
 * Simulated ids. The scenario (and for payments the authorized amount) is
 * part of the id, and the random part is a hash of the idempotency key, so a
 * retried call returns the same id in any process.
 *
 * - customer `cus_sim_<hash>`
 * - method `pm_sim_<scenario>_<last4>_<hash>`
 * - payment `pi_sim_<scenario>_<amountCents>_<hash>`
 * - refund `re_sim_<hash>`, operation `op_sim_<hash>`, event `evt_sim_<hash>`, dispute `dp_sim_<hash>`
 *
 * Seeded and older ids (`pm_sim_000001`, `pi_sim_<24 hex>`) carry no scenario
 * and use 'random'.
 */
export function keyHash(key: string, length = 16): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, length);
}

export function customerId(idempotencyKey: string): string {
  return `cus_sim_${keyHash(idempotencyKey)}`;
}

export function methodId(
  scenario: SimulatedScenario,
  last4: string,
  idempotencyKey: string,
): string {
  return `pm_sim_${scenario}_${last4}_${keyHash(idempotencyKey, 12)}`;
}

export function paymentId(
  scenario: SimulatedScenario,
  amountCents: number,
  idempotencyKey: string,
): string {
  return `pi_sim_${scenario}_${String(amountCents)}_${keyHash(idempotencyKey, 12)}`;
}

export function prefixedId(prefix: 're' | 'op' | 'evt' | 'dp', key: string): string {
  return `${prefix}_sim_${keyHash(key)}`;
}

function isScenario(value: string | undefined): value is SimulatedScenario {
  return value != null && (SIMULATED_SCENARIOS as readonly string[]).includes(value);
}

export interface ParsedMethodId {
  scenario: SimulatedScenario;
  last4: string | null;
}

/** Null when the id is not a simulated method id. */
export function parseMethodId(id: string): ParsedMethodId | null {
  if (!id.startsWith('pm_sim_')) return null;
  const [scenario, last4] = id.slice('pm_sim_'.length).split('_');
  if (!isScenario(scenario)) return { scenario: 'random', last4: null };
  return { scenario, last4: last4 != null && /^\d{4}$/.test(last4) ? last4 : null };
}

export interface ParsedPaymentId {
  scenario: SimulatedScenario;
  amountCents: number | null;
}

/** Null when the id is not a simulated payment id. */
export function parsePaymentId(id: string): ParsedPaymentId | null {
  if (!id.startsWith('pi_sim_')) return null;
  const [scenario, amount] = id.slice('pi_sim_'.length).split('_');
  if (!isScenario(scenario)) return { scenario: 'random', amountCents: null };
  const amountCents = amount != null && /^\d+$/.test(amount) ? Number(amount) : null;
  return { scenario, amountCents };
}

/** A number in [0, 1) derived from the key: the same call always gets the same random outcome. */
export function keyFraction(key: string): number {
  return parseInt(keyHash(`random:${key}`, 8), 16) / 0x1_0000_0000;
}
