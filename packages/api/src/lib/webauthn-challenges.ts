// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Redis } from 'ioredis';
import { createRedisClient } from '@evtivity/lib';
import { config } from './config.js';
import {
  parseWebauthnChallengeRecord,
  type WebauthnChallengeRecord,
} from './webauthn-challenge-records.js';

// The key sits under the API user's single-use nonce prefix (`attest:nonce:*`
// in the Redis ACL), so no ACL change is needed; `webauthn:` keeps the uses apart.
const WEBAUTHN_CHALLENGE_KEY_PREFIX = 'attest:nonce:webauthn:';

/** How long a ceremony may take between its options and its response. */
const WEBAUTHN_CHALLENGE_TTL_SECONDS = 300;

let redis: Redis | null = null;
function client(): Redis {
  if (redis == null) {
    redis = createRedisClient(config.REDIS_URL, 'webauthn-challenges', { maxRetriesPerRequest: 2 });
  }
  return redis;
}

/** Stores a new challenge for one ceremony. */
export async function saveWebauthnChallenge(
  challenge: string,
  record: WebauthnChallengeRecord,
): Promise<void> {
  await client().set(
    `${WEBAUTHN_CHALLENGE_KEY_PREFIX}${challenge}`,
    JSON.stringify(record),
    'EX',
    WEBAUTHN_CHALLENGE_TTL_SECONDS,
  );
}

/**
 * Reads and deletes a challenge in one step (GETDEL), so each challenge
 * answers one response: a replay, a second parallel response or an expired
 * challenge gets null.
 */
export async function takeWebauthnChallenge(
  challenge: string,
): Promise<WebauthnChallengeRecord | null> {
  if (challenge === '') return null;
  const raw = await client().getdel(`${WEBAUTHN_CHALLENGE_KEY_PREFIX}${challenge}`);
  return raw == null ? null : parseWebauthnChallengeRecord(raw);
}
