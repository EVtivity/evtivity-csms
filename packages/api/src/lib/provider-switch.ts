// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { createRedisClient } from '@evtivity/lib';
import { assertProviderSelectable, PaymentProviderUpgradePendingError } from '@evtivity/payments';
import type { ProcessWatchStore } from '@evtivity/payments';
import { config } from './config.js';
import { ERROR_CODES, ERROR_MESSAGES } from './error-codes.generated.js';

/** The setting that selects the provider for new payments. */
export const PAYMENT_PROVIDER_KEY = 'payments.provider';

let redis: Redis | null = null;

function redisClient(): Redis {
  if (redis == null) {
    redis = createRedisClient(config.REDIS_URL, 'provider-switch-guard', {
      maxRetriesPerRequest: 2,
    });
  }
  return redis;
}

/**
 * Redis holding the worker's process-version watch. The client is created on
 * the first guard check (one per process), so listing providers that are not
 * guarded never connects.
 */
const redisStore: ProcessWatchStore = {
  get: (key) => redisClient().get(key),
  set: (key, value, secondsToken, seconds) => redisClient().set(key, value, secondsToken, seconds),
};

let store: ProcessWatchStore = redisStore;

/** The store the provider-switch guard reads the watch from. */
export function providerSwitchStore(): ProcessWatchStore {
  return store;
}

/** Tests replace the Redis store; null restores it. */
export function setProviderSwitchStore(next: ProcessWatchStore | null): void {
  store = next ?? redisStore;
}

/**
 * Runs the provider-switch guard when a write sets `payments.provider`
 * (every writer calls this). Throws PaymentProviderUpgradePendingError while
 * processes of a release before v0.1.38 may run and the provider is guarded.
 */
export async function assertPaymentProviderWritable(key: string, value: unknown): Promise<void> {
  if (key !== PAYMENT_PROVIDER_KEY || typeof value !== 'string') return;
  await assertProviderSelectable(value, providerSwitchStore());
}

/**
 * Answers 409 PAYMENT_PROVIDER_UPGRADE_PENDING with the guard details and
 * returns true for a guard refusal; returns false for any other error.
 */
export async function replyIfProviderUpgradePending(
  reply: FastifyReply,
  err: unknown,
): Promise<boolean> {
  if (!(err instanceof PaymentProviderUpgradePendingError)) return false;
  await reply.status(409).send({
    error: ERROR_MESSAGES.PAYMENT_PROVIDER_UPGRADE_PENDING,
    code: ERROR_CODES.PAYMENT_PROVIDER_UPGRADE_PENDING,
    details: err.details,
  });
  return true;
}
