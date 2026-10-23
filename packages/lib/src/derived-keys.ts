// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { hkdfSync } from 'node:crypto';

/**
 * One key per use, derived with HKDF-SHA256 (RFC 5869, empty salt) from a
 * deployment secret and a fixed label, so a value one use signs cannot pass
 * as another's and no use shares the key that signs the JWTs or encrypts the
 * settings. Every derived key of the platform has its label here. Changing a
 * label changes that key: stored values signed with it stop verifying.
 */
export const KEY_LABELS = {
  /** Cookie signatures (API), from JWT_SECRET. */
  cookies: 'evtivity cookie signing v1',
  /** Guest QR scan tokens (API), from JWT_SECRET. */
  guestQr: 'evtivity guest QR scan token v2',
  /** Shared station known-good digests (OCPP), from SETTINGS_ENCRYPTION_KEY. */
  stationKnownGood: 'evtivity station auth known-good v1',
  /** Simulated payment provider webhooks, from SETTINGS_ENCRYPTION_KEY. */
  simulatedWebhook: 'simulated-webhook',
} as const;

export type KeyLabel = (typeof KEY_LABELS)[keyof typeof KEY_LABELS];

/** The 32-byte key of one use, from a deployment secret and its label. */
export function deriveKey(secret: string, label: KeyLabel): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), label, 32));
}
