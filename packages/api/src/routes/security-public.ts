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
} from '@evtivity/database';
import { itemResponse } from '../lib/response-schemas.js';

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
    roamingEnabled: z.boolean().describe('Whether OCPI roaming is enabled'),
    ssoEnabled: z.boolean().describe('Whether SSO login is enabled'),
    supportAiEnabled: z.boolean().describe('Whether the support case AI assist feature is enabled'),
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
        response: { 200: itemResponse(publicSecurityResponse) },
      },
    },
    async () => {
      const [recaptcha, mfa, roaming, ssoConfig, supportAi] = await Promise.all([
        getRecaptchaConfig(),
        getMfaConfig(),
        isRoamingEnabled(),
        getSsoConfig(),
        isSupportAiEnabled(),
      ]);

      const mfaMethods: string[] = [];
      if (mfa.emailEnabled) mfaMethods.push('email');
      if (mfa.totpEnabled) mfaMethods.push('totp');
      if (mfa.smsEnabled) mfaMethods.push('sms');

      return {
        recaptchaEnabled: recaptcha != null,
        recaptchaSiteKey: recaptcha?.siteKey ?? '',
        mfaMethods,
        roamingEnabled: roaming,
        ssoEnabled: ssoConfig != null,
        supportAiEnabled: supportAi,
      };
    },
  );
}
