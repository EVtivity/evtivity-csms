// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  AI_PROVIDER_IDS,
  REMOVED_AI_SETTING_KEYS,
  aiProviderApiKeySettingKey,
  encryptString,
} from '@evtivity/lib';

// seed.config.json uses plaintext key names (no Enc suffix) for secrets. The
// seed maps each to its `Enc` settings key and encrypts the value, so a
// secret is never stored as a plaintext row (design principle P12).

/** `ai.<provider>.apiKey` (seed.config.json name) for every AI provider. */
function aiProviderApiKeyInputs(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const provider of AI_PROVIDER_IDS) {
    map[`ai.${provider}.apiKey`] = aiProviderApiKeySettingKey(provider);
  }
  return map;
}

/** seed.config.json secret name -> encrypted settings key. */
export const SEED_ENCRYPTED_KEY_MAP: Readonly<Record<string, string>> = {
  's3.accessKeyId': 's3.accessKeyIdEnc',
  's3.secretAccessKey': 's3.secretAccessKeyEnc',
  'stripe.secretKey': 'stripe.secretKeyEnc',
  'stripe.webhookSecret': 'stripe.webhookSecretEnc',
  'stripe.connectWebhookSecret': 'stripe.connectWebhookSecretEnc',
  'adyen.apiKey': 'adyen.apiKeyEnc',
  'adyen.hmacKey': 'adyen.hmacKeyEnc',
  'adyen.hmacKeyPrevious': 'adyen.hmacKeyPreviousEnc',
  'adyen.webhookPassword': 'adyen.webhookPasswordEnc',
  'security.recaptcha.secretKey': 'security.recaptcha.secretKeyEnc',
  'pnc.hubject.clientSecret': 'pnc.hubject.clientSecretEnc',
  'pnc.local.ca': 'pnc.local.caEnc',
  ...aiProviderApiKeyInputs(),
  'sso.cert': 'sso.certEnc',
  'smtp.password': 'smtp.passwordEnc',
  'twilio.authToken': 'twilio.authTokenEnc',
  'ftp.password': 'ftp.passwordEnc',
  'googleMaps.apiKey': 'googleMaps.apiKeyEnc',
  'mobile.attestation.android.serviceAccount': 'mobile.attestation.android.serviceAccountEnc',
};

/**
 * Keys removed from the settings, with their replacement (JSON input names
 * included: the plaintext names map to the removed per-surface Enc keys).
 */
export const REMOVED_SEED_SETTING_KEYS: Readonly<Record<string, string>> = {
  ...REMOVED_AI_SETTING_KEYS,
  'chatbotAi.apiKey': 'ai.<provider>.apiKey',
  'supportAi.apiKey': 'ai.<provider>.apiKey',
};

// The last segment of a key that names a credential. Publishable values
// (`stripe.publishableKey`, `adyen.clientKey`, `security.recaptcha.siteKey`)
// and names that only contain a word (`tokenUrl`, `userDailyTokens`) do not
// match.
const SECRET_SEGMENT =
  /(?:api[-_]?key|secret|secret[-_]?key|access[-_]?key(?:[-_]?id)?|password|passphrase|token|private[-_]?key|hmac[-_]?key(?:[-_]?previous)?|cert|certificate|credentials?|service[-_]?account)$/i;

/**
 * True for a settings key that holds a credential but is not an `Enc` key:
 * stored under that name, its value would be a plaintext secret.
 */
export function isPlaintextSecretSettingKey(key: string): boolean {
  if (key.endsWith('Enc')) return false;
  const segment = key.slice(key.lastIndexOf('.') + 1);
  return segment === 'ca' || SECRET_SEGMENT.test(segment);
}

export interface MappedSeedSettings {
  /** Settings keyed by their database name. */
  settings: Record<string, unknown>;
  /** One line per seed.config.json key that was not written. */
  warnings: string[];
}

/**
 * Maps seed.config.json settings to their database keys. A secret name goes
 * to its `Enc` key. A removed key, and a secret-looking key with no `Enc`
 * mapping, is skipped with a warning and never written.
 */
export function mapSeedSettings(overrides: Record<string, unknown>): MappedSeedSettings {
  const settings: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    const dbKey = SEED_ENCRYPTED_KEY_MAP[key] ?? key;
    const replacement = REMOVED_SEED_SETTING_KEYS[key] ?? REMOVED_SEED_SETTING_KEYS[dbKey];
    if (replacement !== undefined) {
      warnings.push(`seed.config.json: ${key} was removed, use ${replacement}. Skipped.`);
      continue;
    }
    if (isPlaintextSecretSettingKey(dbKey)) {
      warnings.push(
        `seed.config.json: ${key} looks like a secret but has no encrypted settings key. Skipped, so it is never stored in plaintext.`,
      );
      continue;
    }
    settings[dbKey] = value;
  }
  return { settings, warnings };
}

/**
 * Settings rows to insert. A non-empty string under an `Enc` key is encrypted
 * with `encryptionKey`; without the key the seed fails rather than store the
 * secret in plaintext. A plaintext secret key never becomes a row.
 */
export function seedSettingRows(
  settings: Record<string, unknown>,
  encryptionKey: string,
): { key: string; value: unknown }[] {
  const rows: { key: string; value: unknown }[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (isPlaintextSecretSettingKey(key)) {
      throw new Error(`Refusing to seed ${key}: a secret setting must use its Enc key.`);
    }
    if (key.endsWith('Enc') && typeof value === 'string' && value !== '') {
      if (encryptionKey === '') {
        throw new Error(
          `Cannot seed ${key} with a non-empty value when SETTINGS_ENCRYPTION_KEY is missing. ` +
            `Set the env var or clear ${key} in seed.config.json.`,
        );
      }
      rows.push({ key, value: encryptString(value, encryptionKey) });
      continue;
    }
    rows.push({ key, value });
  }
  return rows;
}
