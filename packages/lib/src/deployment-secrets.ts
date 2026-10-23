// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Secret values published in this repository (Compose defaults, the example
 * env file, the config default). Anyone can sign tokens or decrypt settings
 * with them, so a deployment must never run with one. The same values live
 * in `scripts/lib/compose-secrets.sh` (a unit test compares them) and in the
 * Helm chart's `secret.yaml` checks: change every copy together.
 */
export const KNOWN_JWT_SECRETS: readonly string[] = [
  'dev-secret-change-in-production',
  'dev-jwt-secret-change-in-production!!',
];

export const KNOWN_SETTINGS_ENCRYPTION_KEYS: readonly string[] = [
  'dev-encryption-key-32chars-long!',
];

/** Shortest JWT secret and settings key a deployment accepts. */
export const MIN_DEPLOYMENT_SECRET_LENGTH = 32;

/** A JWT secret that is too short or a published example value. */
export function isWeakJwtSecret(value: string): boolean {
  return value.length < MIN_DEPLOYMENT_SECRET_LENGTH || KNOWN_JWT_SECRETS.includes(value);
}

/** A settings encryption key that is too short or a published example value. */
export function isWeakSettingsEncryptionKey(value: string): boolean {
  return (
    value.length < MIN_DEPLOYMENT_SECRET_LENGTH || KNOWN_SETTINGS_ENCRYPTION_KEYS.includes(value)
  );
}
