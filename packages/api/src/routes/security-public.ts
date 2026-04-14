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
    recaptchaEnabled: z.boolean(),
    recaptchaSiteKey: z.string(),
    mfaMethods: z.array(z.string()),
    roamingEnabled: z.boolean(),
    ssoEnabled: z.boolean(),
    supportAiEnabled: z.boolean(),
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
