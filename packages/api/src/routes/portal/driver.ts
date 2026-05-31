// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import argon2 from 'argon2';
import { db, client, getMfaConfig } from '@evtivity/database';
import { drivers, driverNotificationPreferences } from '@evtivity/database';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  encryptString,
  decryptString,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  createMfaChallenge,
  verifyMfaChallenge,
} from '@evtivity/lib';
import QRCode from 'qrcode';
import { zodSchema } from '../../lib/zod-schema.js';
import { validatePasswordComplexity } from '../../lib/password-validation.js';
import { ALL_TEMPLATES_DIRS } from '../../lib/template-dirs.js';
import { getPubSub } from '../../lib/pubsub.js';
import {
  successResponse,
  itemResponse,
  errorWith,
  errorResponse,
} from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import { config as apiConfig } from '../../lib/config.js';
import { revokeAllDriverRefreshTokens } from '../../services/refresh-token.service.js';

const portalDriverProfile = z
  .object({
    id: z.string().describe('Driver ID (nanoid prefixed with drv_)'),
    firstName: z.string().max(100).nullable().describe('Driver first name'),
    lastName: z.string().max(100).nullable().describe('Driver last name'),
    email: z.string().email().max(255).nullable().describe('Driver email address'),
    phone: z.string().max(50).nullable().describe('Driver phone number in E.164 format'),
    language: z
      .string()
      .max(10)
      .nullable()
      .describe('Preferred UI and notification language code (e.g. en, es, zh)'),
    timezone: z
      .string()
      .max(50)
      .nullable()
      .describe('Preferred IANA timezone (e.g. America/Los_Angeles)'),
    themePreference: z.enum(['light', 'dark']).describe('Preferred UI theme'),
    distanceUnit: z.enum(['miles', 'km']).describe('Preferred distance unit (miles or kilometers)'),
    isActive: z.boolean().describe('Whether the driver account is active'),
    createdAt: z.coerce.date().describe('Timestamp the driver account was created'),
  })
  .passthrough();

const notificationPrefsItem = z
  .object({
    emailEnabled: z.boolean().describe('Whether email notifications are enabled'),
    smsEnabled: z.boolean().describe('Whether SMS notifications are enabled'),
  })
  .passthrough();

const updateProfileBody = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  phone: z.string().max(50).optional(),
  // Restrict to the locales the portal/CSMS bundle ships translations for
  // (frontend/i18n.md). An arbitrary string would persist and then break
  // the i18n loader on the next session.
  language: z.enum(['en', 'de', 'es', 'ko', 'zh', 'zh-TW']).optional(),
  timezone: z.string().max(50).optional(),
  themePreference: z.enum(['light', 'dark']).optional(),
  distanceUnit: z.enum(['miles', 'km']).optional(),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

export function portalDriverRoutes(app: FastifyInstance): void {
  app.patch(
    '/portal/driver/profile',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Update the authenticated driver profile',
        operationId: 'portalUpdateProfile',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateProfileBody),
        response: {
          200: itemResponse(portalDriverProfile),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof updateProfileBody>;

      const fields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.firstName !== undefined) fields['firstName'] = body.firstName;
      if (body.lastName !== undefined) fields['lastName'] = body.lastName;
      if (body.phone !== undefined) fields['phone'] = body.phone;
      if (body.language !== undefined) fields['language'] = body.language;
      if (body.timezone !== undefined) fields['timezone'] = body.timezone;
      if (body.themePreference !== undefined) fields['themePreference'] = body.themePreference;
      if (body.distanceUnit !== undefined) fields['distanceUnit'] = body.distanceUnit;

      const [updated] = await db
        .update(drivers)
        .set(fields)
        .where(eq(drivers.id, driverId))
        .returning({
          id: drivers.id,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          email: drivers.email,
          phone: drivers.phone,
          language: drivers.language,
          timezone: drivers.timezone,
          themePreference: drivers.themePreference,
          distanceUnit: drivers.distanceUnit,
          isActive: drivers.isActive,
          createdAt: drivers.createdAt,
        });

      if (updated == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      return updated;
    },
  );

  app.patch(
    '/portal/driver/password',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Change the authenticated driver password',
        operationId: 'portalChangePassword',
        security: [{ bearerAuth: [] }],
        body: zodSchema(changePasswordBody),
        response: {
          200: successResponse,
          400: errorWith('Weak password', [ERROR_CODES.WEAK_PASSWORD]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof changePasswordBody>;

      const [driver] = await db
        .select({ passwordHash: drivers.passwordHash })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      if (driver == null || driver.passwordHash == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      const valid = await argon2.verify(driver.passwordHash, body.currentPassword);
      if (!valid) {
        await reply
          .status(400)
          .send({ error: 'Current password is incorrect', code: 'INVALID_PASSWORD' });
        return;
      }

      const complexityError = validatePasswordComplexity(body.newPassword);
      if (complexityError != null) {
        await reply.status(400).send({ error: complexityError, code: 'WEAK_PASSWORD' });
        return;
      }

      const newHash = await argon2.hash(body.newPassword);
      await db
        .update(drivers)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(drivers.id, driverId));

      // Revoke all existing refresh tokens to invalidate other sessions
      await revokeAllDriverRefreshTokens(driverId);

      void dispatchDriverNotification(
        client,
        'driver.PasswordChanged',
        driverId,
        {},
        ALL_TEMPLATES_DIRS,
        getPubSub(),
      );

      return { success: true };
    },
  );

  app.get(
    '/portal/driver/notification-preferences',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Get driver notification preferences',
        operationId: 'portalGetNotificationPreferences',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(notificationPrefsItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;

      const [row] = await db
        .select({
          emailEnabled: driverNotificationPreferences.emailEnabled,
          smsEnabled: driverNotificationPreferences.smsEnabled,
        })
        .from(driverNotificationPreferences)
        .where(eq(driverNotificationPreferences.driverId, driverId));

      if (row == null) {
        return { emailEnabled: true, smsEnabled: true };
      }

      return { emailEnabled: row.emailEnabled, smsEnabled: row.smsEnabled };
    },
  );

  app.put(
    '/portal/driver/notification-preferences',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Update driver notification preferences',
        operationId: 'portalUpdateNotificationPreferences',
        security: [{ bearerAuth: [] }],
        body: zodSchema(notificationPrefsItem),
        response: { 200: itemResponse(notificationPrefsItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof notificationPrefsItem>;

      await db
        .insert(driverNotificationPreferences)
        .values({
          driverId,
          emailEnabled: body.emailEnabled,
          smsEnabled: body.smsEnabled,
        })
        .onConflictDoUpdate({
          target: driverNotificationPreferences.driverId,
          set: {
            emailEnabled: body.emailEnabled,
            smsEnabled: body.smsEnabled,
            updatedAt: new Date(),
          },
        });

      return { emailEnabled: body.emailEnabled, smsEnabled: body.smsEnabled };
    },
  );

  // MFA profile endpoints

  const mfaStatusResponse = z
    .object({
      mfaEnabled: z.boolean().describe('Whether MFA is enabled for this driver'),
      mfaMethod: z
        .string()
        .nullable()
        .describe('Active MFA method (totp, email, sms) or null if MFA is disabled'),
      availableMethods: z
        .array(z.string())
        .describe('MFA methods enabled by the system administrator (totp, email, sms)'),
    })
    .passthrough();

  app.get(
    '/portal/driver/mfa',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Get current MFA status',
        operationId: 'portalGetMfaStatus',
        security: [{ bearerAuth: [] }],
        response: { 200: itemResponse(mfaStatusResponse) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const [driver] = await db
        .select({ mfaEnabled: drivers.mfaEnabled, mfaMethod: drivers.mfaMethod })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      const mfaConfig = await getMfaConfig();
      const availableMethods: string[] = [];
      if (mfaConfig.emailEnabled) availableMethods.push('email');
      if (mfaConfig.totpEnabled) availableMethods.push('totp');
      if (mfaConfig.smsEnabled) availableMethods.push('sms');

      return {
        mfaEnabled: driver?.mfaEnabled ?? false,
        mfaMethod: driver?.mfaMethod ?? null,
        availableMethods,
      };
    },
  );

  const mfaSetupBody = z.object({
    method: z.enum(['email', 'totp', 'sms']),
  });

  const mfaSetupResponse = z
    .object({
      qrDataUri: z
        .string()
        .optional()
        .describe('PNG data URI of the TOTP QR code (TOTP setup only)'),
      secret: z
        .string()
        .optional()
        .describe('Plaintext TOTP secret for manual entry (TOTP setup only)'),
      challengeId: z
        .number()
        .optional()
        .describe('Email/SMS challenge ID used by the confirm step (email/sms setup only)'),
    })
    .passthrough();

  app.post(
    '/portal/driver/mfa/setup',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Start MFA setup',
        operationId: 'portalSetupMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaSetupBody),
        response: {
          200: itemResponse(mfaSetupResponse),
          400: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
          403: errorWith('MFA method disabled', [ERROR_CODES.MFA_METHOD_DISABLED]),
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { method } = request.body as z.infer<typeof mfaSetupBody>;

      const mfaConfig = await getMfaConfig();
      const methodEnabled =
        (method === 'email' && mfaConfig.emailEnabled) ||
        (method === 'totp' && mfaConfig.totpEnabled) ||
        (method === 'sms' && mfaConfig.smsEnabled);
      if (!methodEnabled) {
        await reply
          .status(403)
          .send({ error: 'MFA method is disabled', code: 'MFA_METHOD_DISABLED' });
        return;
      }

      const [driver] = await db
        .select({
          email: drivers.email,
          phone: drivers.phone,
          firstName: drivers.firstName,
          language: drivers.language,
          mfaEnabled: drivers.mfaEnabled,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      if (driver == null) {
        await reply.status(400).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      // Block re-setup when MFA is already enabled. Overwriting `totpSecretEnc`
      // here without a follow-up confirm would replace the live secret that
      // the driver's authenticator app still trusts, locking them out at next
      // login. Force them through disable (password-gated) first.
      if (driver.mfaEnabled) {
        await reply
          .status(409)
          .send({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
        return;
      }

      if (method === 'totp') {
        const secret = generateTotpSecret();
        const uri = generateTotpUri(secret, driver.email ?? '', 'EVtivity');
        const qrDataUri = await QRCode.toDataURL(uri);

        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        const encSecret = encryptString(secret, encKey);
        await db
          .update(drivers)
          .set({ totpSecretEnc: encSecret, updatedAt: new Date() })
          .where(eq(drivers.id, driverId));

        return { qrDataUri, secret };
      }

      const challenge = await createMfaChallenge(client, { driverId, method });

      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        {
          email: driver.email ?? undefined,
          phone: driver.phone ?? undefined,
          firstName: driver.firstName,
          language: driver.language,
        },
        { code: challenge.code },
        ALL_TEMPLATES_DIRS,
      );

      return { challengeId: challenge.challengeId };
    },
  );

  const mfaConfirmBody = z.object({
    method: z.enum(['email', 'totp', 'sms']),
    code: z.string().min(6).max(6),
    challengeId: z.coerce.number().int().min(1).optional(),
  });

  app.post(
    '/portal/driver/mfa/confirm',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Confirm MFA setup with verification code',
        operationId: 'portalConfirmMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaConfirmBody),
        response: {
          200: successResponse,
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_CODE_INVALID,
            ERROR_CODES.TOTP_NOT_CONFIGURED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { method, code, challengeId } = request.body as z.infer<typeof mfaConfirmBody>;

      let verified = false;
      if (method === 'totp') {
        const [driver] = await db
          .select({ totpSecretEnc: drivers.totpSecretEnc })
          .from(drivers)
          .where(eq(drivers.id, driverId));
        if (driver?.totpSecretEnc == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        try {
          const secret = decryptString(driver.totpSecretEnc, encKey);
          verified = verifyTotpCode(secret, code);
        } catch (err: unknown) {
          // Mirror the /portal/auth/mfa/verify path: a corrupted ciphertext
          // or rotated SETTINGS_ENCRYPTION_KEY would otherwise surface as a
          // raw 500. Return a clean 400 and log the root cause.
          request.log.warn({ err, driverId }, 'TOTP secret decrypt failed');
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
      } else if (challengeId != null) {
        verified = await verifyMfaChallenge(client, challengeId, code, { driverId });
      }

      if (!verified) {
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }

      await db
        .update(drivers)
        .set({ mfaEnabled: true, mfaMethod: method, updatedAt: new Date() })
        .where(eq(drivers.id, driverId));

      return { success: true };
    },
  );

  const mfaDisableBody = z.object({
    password: z.string().min(1),
  });

  app.delete(
    '/portal/driver/mfa',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Disable MFA',
        operationId: 'portalDisableMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaDisableBody),
        response: {
          200: successResponse,
          400: errorWith('Bad request', [
            ERROR_CODES.DRIVER_NOT_FOUND,
            ERROR_CODES.INVALID_PASSWORD,
          ]),
        },
      },
      // Tight bucket so a stolen session token cannot brute-force the
      // disable password by spamming this endpoint. Parity with the
      // operator MFA DELETE which has the same 5/min cap.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { password } = request.body as z.infer<typeof mfaDisableBody>;

      const [driver] = await db
        .select({ passwordHash: drivers.passwordHash })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      if (driver == null || driver.passwordHash == null) {
        await reply.status(400).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      const valid = await argon2.verify(driver.passwordHash, password);
      if (!valid) {
        await reply.status(400).send({ error: 'Invalid password', code: 'INVALID_PASSWORD' });
        return;
      }

      await db
        .update(drivers)
        .set({
          mfaEnabled: false,
          mfaMethod: null,
          totpSecretEnc: null,
          updatedAt: new Date(),
        })
        .where(eq(drivers.id, driverId));

      // Notify the driver out-of-band. If MFA was disabled by an attacker with
      // a stolen session, the legitimate owner sees the email/SMS/push and can
      // re-enable 2FA and rotate their password before the attacker uses
      // password-only access on future logins.
      void dispatchDriverNotification(
        client,
        'driver.MfaDisabled',
        driverId,
        {},
        ALL_TEMPLATES_DIRS,
        getPubSub(),
      );

      return { success: true };
    },
  );
}
