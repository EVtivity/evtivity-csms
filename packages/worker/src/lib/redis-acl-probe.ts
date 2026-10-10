// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Key prefixes the worker writes outside BullMQ: the maintenance fan-out lock
 * (`mfl:`), the station message render lock (`sml:`) and the worker job locks
 * (`wkl:`, cron jobs, fleet billing fan-out, conformance runs). Each needs a
 * `~<prefix>*` grant on the worker Redis user (docker/redis/acl-rules.conf).
 */
export const WORKER_LOCK_PREFIXES = ['wkl:', 'mfl:', 'sml:'] as const;

const PROBE_TTL_MS = 10_000;

export class RedisAclGrantMissingError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `The worker Redis user may not write the key prefix(es) ${missing.join(', ')}. ` +
        `Grant ${missing.map((p) => `~${p}*`).join(' ')} to the worker ACL user: apply the ` +
        'current acl-rules.conf of this release to Redis (Docker Compose: recreate the redis ' +
        'service; bundled Helm Redis: the chart upgrade applies it; external Redis: run the ' +
        'ACL SETUSER commands of the release notes), then restart the worker.',
    );
    this.name = 'RedisAclGrantMissingError';
  }
}

function isNoPerm(err: unknown): boolean {
  return err instanceof Error && /^NOPERM/i.test(err.message);
}

/**
 * Proves at startup that the worker may write each lock key prefix, so a
 * worker whose Redis user lacks a grant fails its rollout instead of every
 * locked job failing later with NOPERM. Sets a short-lived probe key with
 * `SET NX PX` and deletes it. Throws `RedisAclGrantMissingError` naming every
 * missing grant; any other Redis error is rethrown as is.
 */
export async function probeWorkerLockGrants(
  redis: Pick<Redis, 'set' | 'del'>,
  prefixes: readonly string[] = WORKER_LOCK_PREFIXES,
): Promise<void> {
  const missing: string[] = [];
  for (const prefix of prefixes) {
    const key = `${prefix}probe:${randomUUID()}`;
    try {
      await redis.set(key, '1', 'PX', PROBE_TTL_MS, 'NX');
      await redis.del(key);
    } catch (err) {
      if (!isNoPerm(err)) throw err;
      missing.push(prefix);
    }
  }
  if (missing.length > 0) throw new RedisAclGrantMissingError(missing);
}
