// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { config } from '../config.js';

// Single-use nonces back the attestation challenge. Stored in Redis with a short
// TTL so an attestation cannot be replayed and expires on its own.
const PREFIX = 'attest:nonce:';
const TTL_SECONDS = 300;

let redis: Redis | null = null;
function client(): Redis {
  if (redis == null) {
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  }
  return redis;
}

export async function issueChallenge(): Promise<string> {
  const nonce = randomBytes(32).toString('base64url');
  await client().set(`${PREFIX}${nonce}`, '1', 'EX', TTL_SECONDS);
  return nonce;
}

// Returns true and removes the nonce if it was issued and not yet used.
export async function consumeChallenge(nonce: string): Promise<boolean> {
  if (nonce === '') return false;
  const deleted = await client().del(`${PREFIX}${nonce}`);
  return deleted === 1;
}
