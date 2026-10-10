// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI_PROVIDER_IDS, decryptString } from '@evtivity/lib';
import {
  SEED_ENCRYPTED_KEY_MAP,
  isPlaintextSecretSettingKey,
  mapSeedSettings,
  seedSettingRows,
} from '../seed-settings.js';

const KEY = 'a'.repeat(64);

describe('SEED_ENCRYPTED_KEY_MAP', () => {
  it('maps the API key of every AI provider to its Enc key', () => {
    for (const provider of AI_PROVIDER_IDS) {
      expect(SEED_ENCRYPTED_KEY_MAP[`ai.${provider}.apiKey`]).toBe(`ai.${provider}.apiKeyEnc`);
    }
  });

  it('maps every key to its own name plus Enc', () => {
    for (const [input, dbKey] of Object.entries(SEED_ENCRYPTED_KEY_MAP)) {
      expect(dbKey).toBe(`${input}Enc`);
    }
  });

  it('covers every secret name in seed.config.default.json', () => {
    const file = resolve(import.meta.dirname, '../../seed.config.default.json');
    const { settings } = JSON.parse(readFileSync(file, 'utf-8')) as {
      settings: Record<string, unknown>;
    };
    const unmapped = Object.keys(settings).filter(
      (key) => SEED_ENCRYPTED_KEY_MAP[key] === undefined && isPlaintextSecretSettingKey(key),
    );
    expect(unmapped).toEqual([]);
  });
});

describe('isPlaintextSecretSettingKey', () => {
  it.each([
    'ai.deepseek.apiKey',
    'ai.mistral.apiKey',
    'ai.openai.organizationSecret',
    'smtp.password',
    'twilio.authToken',
    's3.secretAccessKey',
    'adyen.hmacKeyPrevious',
    'pnc.local.ca',
    'sso.cert',
    'mobile.attestation.android.serviceAccount',
  ])('flags %s', (key) => {
    expect(isPlaintextSecretSettingKey(key)).toBe(true);
  });

  it.each([
    'ai.deepseek.apiKeyEnc',
    'ai.deepseek.baseUrl',
    'ai.budget.userDailyTokens',
    'pnc.hubject.tokenUrl',
    'refreshTokens.retentionDays',
    'stripe.publishableKey',
    'adyen.clientKey',
    'security.recaptcha.siteKey',
    'chatbotAi.provider',
  ])('accepts %s', (key) => {
    expect(isPlaintextSecretSettingKey(key)).toBe(false);
  });
});

describe('mapSeedSettings', () => {
  it('maps plaintext AI provider key names to their Enc keys', () => {
    const { settings, warnings } = mapSeedSettings({
      'ai.deepseek.apiKey': 'sk-deepseek',
      'ai.openai.apiKey': 'sk-openai',
      'ai.deepseek.baseUrl': '',
      'chatbotAi.provider': 'deepseek',
    });
    expect(settings).toEqual({
      'ai.deepseek.apiKeyEnc': 'sk-deepseek',
      'ai.openai.apiKeyEnc': 'sk-openai',
      'ai.deepseek.baseUrl': '',
      'chatbotAi.provider': 'deepseek',
    });
    expect(warnings).toEqual([]);
  });

  it('skips a secret-looking key it cannot map, with a warning', () => {
    const { settings, warnings } = mapSeedSettings({
      'ai.mistral.apiKey': 'sk-mistral',
      'custom.webhookSecret': 'whsec',
      'company.name': 'Acme',
    });
    expect(settings).toEqual({ 'company.name': 'Acme' });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('ai.mistral.apiKey');
    expect(warnings[0]).not.toContain('sk-mistral');
  });

  it('skips removed keys, including the per-surface AI key names', () => {
    const { settings, warnings } = mapSeedSettings({
      'chatbotAi.apiKey': 'sk-old',
      'supportAi.apiKeyEnc': 'sk-old',
      'chatbotAi.temperature': 0.5,
    });
    expect(settings).toEqual({});
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('ai.<provider>.apiKey');
  });

  it('keeps an Enc key given by its database name', () => {
    expect(mapSeedSettings({ 'ai.gemini.apiKeyEnc': 'g-key' }).settings).toEqual({
      'ai.gemini.apiKeyEnc': 'g-key',
    });
  });
});

describe('seedSettingRows', () => {
  it('encrypts a non-empty Enc value with the settings key', () => {
    const rows = seedSettingRows(
      { 'ai.deepseek.apiKeyEnc': 'sk-deepseek', 'ai.openai.apiKeyEnc': '', 'company.name': 'A' },
      KEY,
    );
    const deepseek = rows.find((r) => r.key === 'ai.deepseek.apiKeyEnc');
    expect(deepseek?.value).not.toBe('sk-deepseek');
    expect(decryptString(deepseek?.value as string, KEY)).toBe('sk-deepseek');
    expect(rows.find((r) => r.key === 'ai.openai.apiKeyEnc')?.value).toBe('');
    expect(rows.find((r) => r.key === 'company.name')?.value).toBe('A');
  });

  it('fails without SETTINGS_ENCRYPTION_KEY instead of storing plaintext', () => {
    expect(() => seedSettingRows({ 'ai.deepseek.apiKeyEnc': 'sk-deepseek' }, '')).toThrow(
      /SETTINGS_ENCRYPTION_KEY/,
    );
  });

  it('never returns a plaintext secret row', () => {
    expect(() => seedSettingRows({ 'ai.deepseek.apiKey': 'sk-deepseek' }, KEY)).toThrow(/Enc key/);
  });

  it('writes every mapped seed config secret only under its Enc key', () => {
    const input = Object.fromEntries(
      Object.keys(SEED_ENCRYPTED_KEY_MAP).map((key) => [key, `plain-${key}`]),
    );
    const rows = seedSettingRows(mapSeedSettings(input).settings, KEY);
    expect(rows).toHaveLength(Object.keys(SEED_ENCRYPTED_KEY_MAP).length);
    for (const row of rows) {
      expect(row.key.endsWith('Enc')).toBe(true);
      expect(String(row.value)).not.toContain('plain-');
    }
  });
});
