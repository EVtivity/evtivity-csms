// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  keys: new Set<string>(),
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('@evtivity/lib', () => ({
  createRedisClient: () => ({
    set: async (key: string) => {
      h.set(key);
      h.keys.add(key);
      return 'OK';
    },
    del: async (key: string) => {
      h.del(key);
      return h.keys.delete(key) ? 1 : 0;
    },
  }),
}));

import { consumeChallenge, issueChallenge } from './challenge.js';

describe('attestation challenge nonces', () => {
  beforeEach(() => {
    h.keys.clear();
  });

  it('issues a base64url nonce that is consumed once', async () => {
    const nonce = await issueChallenge();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await consumeChallenge(nonce)).toBe(true);
    expect(await consumeChallenge(nonce)).toBe(false);
  });

  it('never deletes a WebAuthn challenge or SAML request key through a crafted nonce', async () => {
    h.keys.add('attest:nonce:webauthn:abc');
    h.keys.add('attest:nonce:saml-req:_123');
    expect(await consumeChallenge('webauthn:abc')).toBe(false);
    expect(await consumeChallenge('saml-req:_123')).toBe(false);
    expect(h.del).not.toHaveBeenCalled();
    expect(h.keys.has('attest:nonce:webauthn:abc')).toBe(true);
    expect(h.keys.has('attest:nonce:saml-req:_123')).toBe(true);
  });

  it('refuses an empty, short or non-base64url nonce without a Redis call', async () => {
    for (const nonce of ['', 'abc', `${'a'.repeat(42)}=`, `${'a'.repeat(42)}:`, 'a'.repeat(44)]) {
      expect(await consumeChallenge(nonce)).toBe(false);
    }
    expect(h.del).not.toHaveBeenCalled();
  });
});
