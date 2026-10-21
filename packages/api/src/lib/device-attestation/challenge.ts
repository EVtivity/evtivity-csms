// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { createRedisClient } from '@evtivity/lib';
import { config } from '../config.js';

// Single-use nonces back the attestation challenge. Stored in Redis with a short
// TTL so an attestation cannot be replayed and expires on its own.
const PREFIX = 'attest:nonce:';
const TTL_SECONDS = 300;

let redis: Redis | null = null;
function client(): Redis {
  if (redis == null) {
    redis = createRedisClient(config.REDIS_URL, 'attestation-nonces', { maxRetriesPerRequest: 2 });
  }
  return redis;
}

export async function issueChallenge(): Promise<string> {
  const nonce = randomBytes(32).toString('base64url');
  await client().set(`${PREFIX}${nonce}`, '1', 'EX', TTL_SECONDS);
  return nonce;
}

// What issueChallenge makes: 32 bytes as base64url. The prefix is shared with the
// WebAuthn challenges and SAML request ids (`attest:nonce:webauthn:`, `attest:nonce:saml-req:`),
// so a client nonce with a colon could otherwise delete one of those keys.
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Returns true and removes the nonce if it was issued and not yet used.
export async function consumeChallenge(nonce: string): Promise<boolean> {
  if (!NONCE_PATTERN.test(nonce)) return false;
  const deleted = await client().del(`${PREFIX}${nonce}`);
  return deleted === 1;
}
