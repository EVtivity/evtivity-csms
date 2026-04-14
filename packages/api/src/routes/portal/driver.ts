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
import { errorResponse, successResponse, itemResponse } from '../../lib/response-schemas.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import { config as apiConfig } from '../../lib/config.js';
import { revokeAllDriverRefreshTokens } from '../../services/refresh-token.service.js';

const portalDriverProfile = z
  .object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    language: z.string().nullable(),
    timezone: z.string().nullable(),
    themePreference: z.string(),
    distanceUnit: z.string(),
    isActive: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();

const notificationPrefsItem = z
  .object({ emailEnabled: z.boolean(), smsEnabled: z.boolean() })
  .passthrough();

const updateProfileBody = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  phone: z.string().max(50).optional(),
  language: z.string().max(10).optional(),
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
        response: { 200: itemResponse(portalDriverProfile), 404: errorResponse },
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
        response: { 200: successResponse, 400: errorResponse, 404: errorResponse },
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

  const updateNotificationPrefsBody = z.object({
    emailEnabled: z.boolean().describe('Whether email notifications are enabled'),
    smsEnabled: z.boolean().describe('Whether SMS notifications are enabled'),
  });

  app.put(
    '/portal/driver/notification-preferences',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Update driver notification preferences',
        operationId: 'portalUpdateNotificationPreferences',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateNotificationPrefsBody),
        response: { 200: itemResponse(notificationPrefsItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof updateNotificationPrefsBody>;

      const [result] = await db
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
        })
        .returning();

      return result;
    },
  );

  // MFA profile endpoints

  const mfaStatusResponse = z
    .object({
      mfaEnabled: z.boolean(),
      mfaMethod: z.string().nullable(),
      availableMethods: z.array(z.string()),
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
      qrDataUri: z.string().optional(),
      secret: z.string().optional(),
      challengeId: z.number().optional(),
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
        response: { 200: itemResponse(mfaSetupResponse), 400: errorResponse },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { method } = request.body as z.infer<typeof mfaSetupBody>;

      const [driver] = await db
        .select({
          email: drivers.email,
          phone: drivers.phone,
          firstName: drivers.firstName,
          language: drivers.language,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      if (driver == null) {
        await reply.status(400).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
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
        response: { 200: successResponse, 400: errorResponse },
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
        const secret = decryptString(driver.totpSecretEnc, encKey);
        verified = verifyTotpCode(secret, code);
      } else if (challengeId != null) {
        verified = await verifyMfaChallenge(client, challengeId, code);
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
        response: { 200: successResponse, 400: errorResponse },
      },
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

      return { success: true };
    },
  );
}
