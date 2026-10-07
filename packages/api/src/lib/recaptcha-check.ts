// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply } from 'fastify';
import { getRecaptchaConfig } from '@evtivity/database';
import { decryptSettingOrNull, verifyRecaptcha } from '@evtivity/lib';
import { config as apiConfig } from './config.js';

/**
 * Verify a reCAPTCHA token from a request body. Returns true when reCAPTCHA
 * is disabled or the token verified above the configured threshold. Returns
 * false after sending a 400 / 403 response when missing or rejected.
 *
 * Shared between operator login (POST /v1/auth/login) and the four portal
 * pre-auth endpoints (login, register, forgot-password, reset-password) so
 * the response shape stays in lockstep across realms.
 */
export async function checkRecaptcha(
  token: string | undefined,
  reply: FastifyReply,
): Promise<boolean> {
  const config = await getRecaptchaConfig();
  if (config == null) return true;
  if (token == null || token === '') {
    await reply
      .status(400)
      .send({ error: 'reCAPTCHA token is required', code: 'RECAPTCHA_REQUIRED' });
    return false;
  }
  const secretKey = decryptSettingOrNull(config.secretKeyEnc, apiConfig.SETTINGS_ENCRYPTION_KEY);
  // Enabled without a secret key is a misconfiguration. Fail closed (P9).
  if (secretKey == null) {
    throw new Error('reCAPTCHA is enabled but security.recaptcha.secretKeyEnc is not set');
  }
  const result = await verifyRecaptcha(token, secretKey, config.threshold);
  if (!result.success) {
    await reply
      .status(403)
      .send({ error: 'reCAPTCHA verification failed', code: 'RECAPTCHA_FAILED' });
    return false;
  }
  return true;
}
