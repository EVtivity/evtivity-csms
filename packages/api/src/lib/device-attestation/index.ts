// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, getAttestationConfig, mobileAttestKeys } from '@evtivity/database';
import { decryptString } from '@evtivity/lib';
import { config } from '../config.js';
import { deviceIdFromRequest } from '../driver-session.js';
import { consumeChallenge, issueChallenge } from './challenge.js';
import { verifyAssertion, verifyRegistration } from './app-attest.js';
import { verifyPlayIntegrity } from './play-integrity.js';

export { issueChallenge };

function header(request: FastifyRequest, name: string): string {
  const v = request.headers[name];
  return typeof v === 'string' ? v : '';
}

export interface RegistrationOutcome {
  ok: boolean;
}

// One-time iOS App Attest registration. Verifies the attestation, then stores
// the device's public key and initial signature counter keyed by X-Device-Id so
// later assertions can be checked. Re-registration for the same device replaces
// the stored key.
export async function registerIosAttestation(
  request: FastifyRequest,
): Promise<RegistrationOutcome> {
  const cfg = await getAttestationConfig();
  if (!cfg.enabled) return { ok: false };

  const deviceId = deviceIdFromRequest(request);
  if (deviceId == null) return { ok: false };

  const body = request.body as { keyId?: string; attestation?: string; challenge?: string };
  const keyId = body.keyId ?? '';
  const attestation = body.attestation ?? '';
  const challenge = body.challenge ?? '';
  if (keyId === '' || attestation === '' || challenge === '') return { ok: false };

  const fresh = await consumeChallenge(challenge);
  if (!fresh) return { ok: false };

  const result = verifyRegistration(attestation, keyId, challenge, {
    teamId: cfg.ios.teamId,
    bundleId: cfg.ios.bundleId,
    environment: cfg.ios.environment,
  });
  if (!result.ok || result.publicKeyPem == null) return { ok: false };

  const now = new Date();
  await db
    .insert(mobileAttestKeys)
    .values({
      deviceId,
      keyId,
      publicKey: result.publicKeyPem,
      signCount: result.signCount ?? 0,
      platform: 'ios',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: mobileAttestKeys.deviceId,
      set: {
        keyId,
        publicKey: result.publicKeyPem,
        signCount: result.signCount ?? 0,
        platform: 'ios',
        updatedAt: now,
      },
    });

  return { ok: true };
}

// Per-request device attestation gate for the pre-auth portal endpoints. Returns
// true when the request is allowed to proceed:
//   - attestation disabled: always true (mobile relies on the rate limit)
//   - iOS: a stored key verifies the assertion and the counter advances
//   - Android: the Play Integrity token decodes to a recognized app + device
// Fail-closed on any verification error.
export async function verifyDeviceAttestation(request: FastifyRequest): Promise<boolean> {
  const cfg = await getAttestationConfig();
  if (!cfg.enabled) return true;

  const platform = header(request, 'x-attest-platform');
  const challenge = header(request, 'x-attest-challenge');
  const attestation = header(request, 'x-device-attestation');
  if (challenge === '' || attestation === '') return false;

  // Single-use nonce consumed before verifying so a captured request cannot
  // be replayed even if the signature still checks out.
  const fresh = await consumeChallenge(challenge);
  if (!fresh) return false;

  if (platform === 'android') {
    if (cfg.android.serviceAccountEnc === '' || cfg.android.packageName === '') return false;
    let serviceAccountJson: string;
    try {
      serviceAccountJson = decryptString(
        cfg.android.serviceAccountEnc,
        config.SETTINGS_ENCRYPTION_KEY,
      );
    } catch {
      return false;
    }
    const result = await verifyPlayIntegrity(attestation, challenge, {
      packageName: cfg.android.packageName,
      serviceAccountJson,
      cloudProjectNumber: cfg.android.cloudProjectNumber,
    });
    return result.ok;
  }

  if (platform === 'ios') {
    const deviceId = deviceIdFromRequest(request);
    if (deviceId == null) return false;
    const [row] = await db
      .select()
      .from(mobileAttestKeys)
      .where(eq(mobileAttestKeys.deviceId, deviceId));
    if (row == null) return false;

    const result = verifyAssertion(attestation, challenge, row.publicKey, row.signCount, {
      teamId: cfg.ios.teamId,
      bundleId: cfg.ios.bundleId,
      environment: cfg.ios.environment,
    });
    if (!result.ok) return false;

    await db
      .update(mobileAttestKeys)
      .set({ signCount: result.newSignCount ?? row.signCount, updatedAt: new Date() })
      .where(eq(mobileAttestKeys.deviceId, deviceId));
    return true;
  }

  return false;
}
