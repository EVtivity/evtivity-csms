// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getRecaptchaConfig,
  getMfaConfig,
  isRoamingEnabled,
  getSsoConfig,
  isSupportAiEnabled,
  getPasswordPolicy,
} from '@evtivity/database';
import { itemResponse } from '../lib/response-schemas.js';
import { zodSchema } from '../lib/zod-schema.js';
import { config as apiConfig } from '../lib/config.js';
import { portalHostAllowsPasskeys } from '../lib/webauthn-rp.js';

const publicSecurityQuery = z.object({
  app: z
    .enum(['csms', 'portal'])
    .optional()
    .describe(
      'The app that asks. The portal sends portal: passkeys are reported off when PORTAL_URL is an IP address, since browsers refuse passkeys there',
    ),
});

const passwordPolicyResponse = z
  .object({
    minLength: z.number().int().describe('Minimum password length'),
    requireUppercase: z.boolean().describe('Whether a password needs an uppercase letter'),
    requireLowercase: z.boolean().describe('Whether a password needs a lowercase letter'),
    requireNumber: z.boolean().describe('Whether a password needs a digit'),
    requireSymbol: z
      .boolean()
      .describe('Whether a password needs an ASCII character that is not a letter, digit or space'),
  })
  .passthrough()
  .describe('Rules a new operator or driver password must meet');

const publicSecurityResponse = z
  .object({
    recaptchaEnabled: z.boolean().describe('Whether reCAPTCHA v3 is enabled on login pages'),
    recaptchaSiteKey: z
      .string()
      .max(255)
      .describe('reCAPTCHA v3 site key for client-side script load'),
    mfaMethods: z
      .array(z.enum(['email', 'totp', 'sms']))
      .max(3)
      .describe('MFA methods available for users to enroll'),
    webauthnEnabled: z
      .boolean()
      .describe(
        'Whether passkeys and security keys can be used as a second factor (with app=portal: false while the portal host is an IP address)',
      ),
    passkeyLoginEnabled: z
      .boolean()
      .describe(
        'Whether operators (with app=portal: drivers) can sign in with a passkey without a password',
      ),
    roamingEnabled: z.boolean().describe('Whether OCPI roaming is enabled'),
    ssoEnabled: z.boolean().describe('Whether SSO login is enabled'),
    supportAiEnabled: z.boolean().describe('Whether the support case AI assist feature is enabled'),
    passwordPolicy: passwordPolicyResponse,
  })
  .passthrough();

export function securityPublicRoutes(app: FastifyInstance): void {
  app.get(
    '/security/public',
    {
      schema: {
        tags: ['Settings'],
        summary: 'Get public security configuration for login pages',
        operationId: 'getPublicSecuritySettings',
        security: [],
        querystring: zodSchema(publicSecurityQuery),
        response: { 200: itemResponse(publicSecurityResponse) },
      },
    },
    async (request) => {
      const { app: client } = request.query as z.infer<typeof publicSecurityQuery>;
      const [recaptcha, mfa, roaming, ssoConfig, supportAi, passwordPolicy] = await Promise.all([
        getRecaptchaConfig(),
        getMfaConfig(),
        isRoamingEnabled(),
        getSsoConfig(),
        isSupportAiEnabled(),
        getPasswordPolicy(),
      ]);

      // Browsers refuse passkeys on a page served from an IP address.
      const passkeysPossible =
        client !== 'portal' || portalHostAllowsPasskeys(apiConfig.PORTAL_URL);
      const webauthnEnabled = mfa.webauthnEnabled && passkeysPossible;

      const mfaMethods: string[] = [];
      if (mfa.emailEnabled) mfaMethods.push('email');
      if (mfa.totpEnabled) mfaMethods.push('totp');
      if (mfa.smsEnabled) mfaMethods.push('sms');

      return {
        recaptchaEnabled: recaptcha != null,
        recaptchaSiteKey: recaptcha?.siteKey ?? '',
        mfaMethods,
        webauthnEnabled,
        passkeyLoginEnabled: webauthnEnabled && mfa.passkeyLoginEnabled,
        roamingEnabled: roaming,
        ssoEnabled: ssoConfig != null,
        supportAiEnabled: supportAi,
        passwordPolicy: {
          minLength: passwordPolicy.minLength,
          requireUppercase: passwordPolicy.requireUppercase,
          requireLowercase: passwordPolicy.requireLowercase,
          requireNumber: passwordPolicy.requireNumber,
          requireSymbol: passwordPolicy.requireSymbol,
        },
      };
    },
  );
}
