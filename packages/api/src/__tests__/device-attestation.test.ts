// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { verifyPlayIntegrity } from '../lib/device-attestation/play-integrity.js';
import { verifyAssertion, verifyRegistration } from '../lib/device-attestation/app-attest.js';

// These cover the fail-closed paths that need no live attestation fixtures: any
// malformed or forged input must return ok:false, never throw. End-to-end
// verification against real Apple/Google tokens is exercised manually with a
// device build before mobile.attestation.enabled is flipped on.

describe('verifyPlayIntegrity', () => {
  it('returns ok:false on a malformed service account (no network call)', async () => {
    const result = await verifyPlayIntegrity('garbage-token', 'nonce', {
      packageName: 'com.evtivity.app',
      serviceAccountJson: 'not-json',
      cloudProjectNumber: '123',
    });
    expect(result.ok).toBe(false);
  });
});

describe('verifyRegistration', () => {
  it('returns ok:false on non-base64 attestation', () => {
    const result = verifyRegistration('!!!not-cbor!!!', 'keyId', 'challenge', {
      teamId: 'TEAM123',
      bundleId: 'com.evtivity.app',
      environment: 'development',
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on empty input', () => {
    const result = verifyRegistration('', '', '', {
      teamId: 'TEAM123',
      bundleId: 'com.evtivity.app',
      environment: 'production',
    });
    expect(result.ok).toBe(false);
  });
});

describe('verifyAssertion', () => {
  it('returns ok:false on garbage assertion', () => {
    const result = verifyAssertion('garbage', 'challenge', 'not-a-pem', 0, {
      teamId: 'TEAM123',
      bundleId: 'com.evtivity.app',
      environment: 'development',
    });
    expect(result.ok).toBe(false);
  });
});
