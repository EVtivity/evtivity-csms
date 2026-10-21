// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import type { CacheItem, CacheProvider } from '@node-saml/node-saml';
import type { SsoConfig } from '@evtivity/database';
import { createRedisClient } from '@evtivity/lib';
import { config } from './config.js';

// The ids of the SAML requests this CSMS sent, kept until the IdP answers.
// The key sits under the API user's single-use nonce prefix (`attest:nonce:*`
// in the Redis ACL), so no ACL change is needed; `saml-req:` keeps the two
// uses apart.
export const SAML_REQUEST_KEY_PREFIX = 'attest:nonce:saml-req:';

// The browser a SAML request was started in: the SHA-256 of the random value of
// its SSO binding cookie, kept beside the request id under the same prefix.
export const SAML_BINDING_KEY_PREFIX = 'attest:nonce:saml-bind:';

/** The SHA-256 (hex) of a binding cookie value, as stored for its request. */
export function samlBindingHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// The time an operator has between the redirect to the IdP and the reply.
// Shorter than node-saml's 8-hour default: a sign-in at the IdP takes minutes.
export const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;

let redis: Redis | null = null;
function client(): Redis {
  if (redis == null) {
    redis = createRedisClient(config.REDIS_URL, 'saml-requests', { maxRetriesPerRequest: 2 });
  }
  return redis;
}

/**
 * A node-saml cache provider over Redis for one HTTP request. The login stores
 * the id of the request it sends; the callback reads it back for the reply's
 * InResponseTo. `consumed` tells whether this request deleted an id it read,
 * so of two posts of one reply only one is accepted (`consumeRead`).
 */
export class RedisSamlRequestCache implements CacheProvider {
  private readonly read = new Set<string>();
  private deleted = false;

  /**
   * `binding`: the hash of the binding cookie the login sets (`samlBindingHash`),
   * stored with the request id so the callback accepts the reply only in the
   * browser that started the sign-in.
   */
  constructor(
    private readonly redisClient: () => Redis = client,
    private readonly binding: string | null = null,
  ) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await this.redisClient().set(
      `${SAML_REQUEST_KEY_PREFIX}${key}`,
      value,
      'PX',
      SAML_REQUEST_TTL_MS,
    );
    if (this.binding != null) {
      await this.redisClient().set(
        `${SAML_BINDING_KEY_PREFIX}${key}`,
        this.binding,
        'PX',
        SAML_REQUEST_TTL_MS,
      );
    }
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    this.read.add(key);
    return this.redisClient().get(`${SAML_REQUEST_KEY_PREFIX}${key}`);
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key == null) return null;
    const removed = await this.redisClient().del(`${SAML_REQUEST_KEY_PREFIX}${key}`);
    if (removed === 1) this.deleted = true;
    return removed === 1 ? key : null;
  }

  /**
   * After a reply validated: deletes the request ids it read and answers
   * whether this request removed one (node-saml may have removed it already
   * while checking the assertion). False means another post of the same reply
   * consumed it first: a replay.
   */
  async consumeRead(): Promise<boolean> {
    for (const key of this.read) {
      await this.removeAsync(key);
    }
    return this.deleted;
  }

  /**
   * After a reply validated: whether the binding cookie value of this request
   * is the one stored for the request id the reply answers. Each binding is
   * read once (GETDEL), so it cannot be tried again.
   */
  async bindingMatches(cookieValue: string | null): Promise<boolean> {
    let matched = false;
    for (const key of this.read) {
      const stored = await this.redisClient().getdel(`${SAML_BINDING_KEY_PREFIX}${key}`);
      if (cookieValue == null || stored == null) continue;
      const expected = Buffer.from(stored, 'hex');
      const actual = Buffer.from(samlBindingHash(cookieValue), 'hex');
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
        matched = true;
      }
    }
    return matched;
  }
}

/**
 * The one SAML client of the login and the callback, so both use the same
 * options: signed replies, and the reply must answer a request this CSMS sent
 * and has not seen answered (`validateInResponseTo: always`).
 */
export function buildSaml(sso: SsoConfig, callbackUrl: string, cache: CacheProvider): SAML {
  return new SAML({
    entryPoint: sso.entryPoint,
    issuer: sso.issuer,
    idpCert: sso.cert,
    callbackUrl,
    wantAuthnResponseSigned: true,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
    cacheProvider: cache,
  });
}

/**
 * Whether the email may sign in with SSO: any domain when the list is empty,
 * else its domain must be listed. Applied to existing accounts and to
 * auto-provisioning.
 */
export function ssoEmailDomainAllowed(email: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.split('@')[1]?.trim().toLowerCase() ?? '';
  return domain !== '' && allowedDomains.includes(domain);
}
