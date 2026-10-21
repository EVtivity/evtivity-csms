// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import argon2 from 'argon2';
import { db, client, getMfaConfig, writeAudit, driverAuditLog } from '@evtivity/database';
import { drivers, driverNotificationPreferences } from '@evtivity/database';
import {
  dispatchDriverNotification,
  dispatchSystemNotification,
  encryptString,
  decryptString,
  generateTotpSecret,
  generateTotpUri,
  matchTotpStep,
  isMfaChallengeLimited,
  verifyMfaChallenge,
  isValidTimezone,
} from '@evtivity/lib';
import QRCode from 'qrcode';
import { zodSchema } from '../../lib/zod-schema.js';
import {
  newPasswordSchema,
  validatePassword,
  weakPasswordFields,
} from '../../lib/password-validation.js';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import {
  successResponse,
  itemResponse,
  errorWith,
  errorResponse,
} from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import { config as apiConfig } from '../../lib/config.js';
import { endDriverSessions } from '../../services/refresh-token.service.js';
import {
  isMobileSession,
  issueDriverSession,
  issueDriverTokens,
} from '../../lib/driver-session.js';
import { driverSessionColumns } from '../../lib/driver-session-columns.js';
import {
  authenticateDriverOrMfaEnrollment,
  driverMfaPolicy,
  isDriverMfaEnrollmentRequest,
} from '../../lib/driver-mfa.js';
import { hasMfa } from '../../lib/mfa-factors.js';
import { checkCurrentPassword } from '../../lib/current-password.js';
import {
  FACTOR_PROOF_KINDS,
  authenticationCredential,
  checkFactorProof,
  factorProof,
  factorProofKindsOf,
  holdsFactor,
  lastFactorProofKindsOf,
  proofAccountOf,
  sendFactorProofRefusal,
} from '../../lib/mfa-factor-proof.js';
import {
  PHONE_CHANGE_METHOD,
  checkPhoneChange,
  INVALID_PHONE_REPLY,
  normalizedPhone,
  phoneToStore,
  phoneVerification,
  phoneVerificationRefusal,
  readPhoneInput,
} from '../../lib/phone-change.js';
import { verifyRecoveryCodesPasskey } from '../../lib/webauthn-http.js';
import { recordAuthAudit } from '../../lib/auth-audit.js';
import { updateDriverBillingAddress } from '../../services/driver-billing.service.js';
import {
  driverBillingAddressBody,
  driverBillingAddressItem,
} from '../../lib/driver-billing-address-schema.js';
import { getAuditActor } from '../../lib/audit-actor.js';
import {
  countRecoveryCodes,
  countWebauthnCredentials,
  recoveryCodesUsedUp,
  deleteRecoveryCodes,
  deleteWebauthnCredentials,
  issueRecoveryCodes,
  mfaFactorCounts,
} from '../../services/mfa-factor.service.js';
import { factorFlags, sendSecurityNotice } from '../../lib/security-notice.js';
import { changedFields } from '../../lib/audit-diff.js';
import {
  hasMfaContact,
  mfaCodeDestination,
  mfaCodeRecipient,
  removesSmsMfaPhone,
} from '../../lib/mfa-contact.js';
import {
  acceptTotpStep,
  clearSignInFailures,
  createAccountMfaChallenge,
  sendMfaResendLimited,
  recordAttemptFailure,
  takeSignInAttempt,
} from '../../lib/sign-in-backoff.js';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

/** The profile fields a portal profile update can change, audited when they do. */
const PROFILE_AUDIT_KEYS = [
  'firstName',
  'lastName',
  'phone',
  'language',
  'timezone',
  'themePreference',
  'distanceUnit',
  'priceDisplay',
] as const;

const profileAuditColumns = {
  firstName: drivers.firstName,
  lastName: drivers.lastName,
  phone: drivers.phone,
  language: drivers.language,
  timezone: drivers.timezone,
  themePreference: drivers.themePreference,
  distanceUnit: drivers.distanceUnit,
  priceDisplay: drivers.priceDisplay,
};

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
    priceDisplay: z
      .enum(['gross', 'net'])
      .nullable()
      .describe(
        'Whether prices are shown including (gross) or excluding (net) tax. Null follows the company setting.',
      ),
    isActive: z.boolean().describe('Whether the driver account is active'),
    createdAt: z.coerce.date().describe('Timestamp the driver account was created'),
  })
  .passthrough();

const notificationPrefsItem = z
  .object({
    emailEnabled: z.boolean().describe('Whether email notifications are enabled'),
    smsEnabled: z.boolean().describe('Whether SMS notifications are enabled'),
    pushEnabled: z
      .boolean()
      .optional()
      .describe('Whether native push notifications are enabled (omit to keep current value)'),
  })
  .passthrough();

const updateProfileBody = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  phone: z
    .string()
    .max(50)
    .optional()
    .describe(
      'Phone number. An empty string removes it, refused while the driver signs in with SMS codes. For a driver with a factor a change needs proof; with SMS codes as the sign-in method it needs phoneVerification instead.',
    ),
  proof: factorProof
    .optional()
    .describe(
      'A phone change of a driver with a factor: fresh proof of the driver (a factor it holds, as to add one)',
    ),
  phoneVerification: phoneVerification.optional(),
  // Restrict to the locales the portal/CSMS bundle ships translations for
  // (frontend/i18n.md). An arbitrary string would persist and then break
  // the i18n loader on the next session.
  language: z.enum(['en', 'de', 'es', 'ko', 'zh', 'zh-TW']).optional(),
  timezone: z.string().max(50).optional().describe('IANA timezone (e.g. Europe/Berlin)'),
  themePreference: z.enum(['light', 'dark']).optional(),
  distanceUnit: z.enum(['miles', 'km']).optional(),
  priceDisplay: z
    .enum(['gross', 'net'])
    .nullable()
    .optional()
    .describe(
      'Show prices including (gross) or excluding (net) tax. Null follows the company setting company.priceDisplay.',
    ),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: newPasswordSchema,
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
        description:
          'A phone change of a driver with a second factor needs proof (a factor it holds; 400 VALIDATION_ERROR with proofKinds otherwise); a driver that signs in with SMS codes instead confirms the new number with phoneVerification, the code POST /v1/portal/driver/phone-verification sent to it. A request with a token of the mobile app gets a message naming the driver portal.',
        security: [{ bearerAuth: [] }],
        body: zodSchema(updateProfileBody),
        response: {
          200: itemResponse(portalDriverProfile),
          400: errorWith(
            'Validation error, or a phone change lacks its proof or verification',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
            ],
            {
              proofKinds: z
                .array(z.enum(FACTOR_PROOF_KINDS))
                .optional()
                .describe('A missing or wrong proof: the proof kinds the driver accepts'),
              phoneVerificationRequired: z
                .boolean()
                .optional()
                .describe('A driver that signs in with SMS codes must confirm the new number'),
              portalUrl: z
                .string()
                .optional()
                .describe('Mobile app: the driver portal, where the change can be made'),
            },
          ),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof updateProfileBody>;

      // An unknown zone would break every date the portal and the
      // notifications format for the driver (Intl throws a RangeError).
      if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
        await reply.status(400).send({ error: 'Invalid IANA timezone', code: 'VALIDATION_ERROR' });
        return;
      }

      const [before] = await db
        .select({
          ...profileAuditColumns,
          mfaEnabled: drivers.mfaEnabled,
          mfaMethod: drivers.mfaMethod,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      // Stored, compared and texted in E.164 only.
      const phoneIn = readPhoneInput(body.phone);
      if (phoneIn.kind === 'invalid') {
        await reply.status(400).send(INVALID_PHONE_REPLY);
        return;
      }
      const phone = phoneToStore(phoneIn);
      // SMS codes need the phone number: removing it would lock the driver out.
      if (before != null && removesSmsMfaPhone(phone, before)) {
        await reply.status(400).send({
          error: 'Turn off SMS sign-in codes before you remove the phone number',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      // SMS codes go to this number: a stolen session must not be able to move them.
      if (phone !== undefined && before != null) {
        const refused = await checkPhoneChange(
          request,
          { driverId },
          {
            current: normalizedPhone(before.phone),
            next: phone,
            proof: body.proof,
            verification: body.phoneVerification,
            mobileSession: isMobileSession(request),
          },
        );
        if (refused != null) {
          await reply.status(refused.status).send(refused.body);
          return;
        }
      }

      const fields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.firstName !== undefined) fields['firstName'] = body.firstName;
      if (body.lastName !== undefined) fields['lastName'] = body.lastName;
      if (phone !== undefined) fields['phone'] = phone;
      if (body.language !== undefined) fields['language'] = body.language;
      if (body.timezone !== undefined) fields['timezone'] = body.timezone;
      if (body.themePreference !== undefined) fields['themePreference'] = body.themePreference;
      if (body.distanceUnit !== undefined) fields['distanceUnit'] = body.distanceUnit;
      if (body.priceDisplay !== undefined) fields['priceDisplay'] = body.priceDisplay;

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
          priceDisplay: drivers.priceDisplay,
          isActive: drivers.isActive,
          createdAt: drivers.createdAt,
        });

      if (updated == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      // Tell the driver, and text the previous number when SMS codes went there.
      if (
        phone !== undefined &&
        before != null &&
        normalizedPhone(before.phone) !== normalizedPhone(updated.phone)
      ) {
        sendSecurityNotice(
          { driverId },
          'security.PhoneChanged',
          { byAdmin: false, phoneRemoved: updated.phone == null },
          request.log,
          { phone: before.mfaEnabled && before.mfaMethod === 'sms' ? before.phone : null },
        );
      }

      const diff =
        before == null
          ? null
          : changedFields(
              before,
              Object.fromEntries(PROFILE_AUDIT_KEYS.map((key) => [key, updated[key]])),
            );
      if (diff != null && Object.keys(diff.after).length > 0) {
        await writeAudit(
          { table: driverAuditLog, idColumn: 'driver_id' },
          {
            entityId: driverId,
            entityIdSnapshot: driverId,
            action: 'updated',
            ...getAuditActor(request),
            before: diff.before,
            after: diff.after,
            notes: 'Profile updated in the driver portal',
          },
          db,
          request.log,
        );
      }

      return updated;
    },
  );

  const phoneVerificationStartBody = z.object({
    phone: z.string().min(1).max(50).describe('The new phone number'),
    proof: factorProof
      .optional()
      .describe(
        'Fresh proof of the driver: a factor it holds, else its password, else none (a driver with neither)',
      ),
  });

  app.post(
    '/portal/driver/phone-verification',
    {
      onRequest: [app.authenticateDriver],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Driver'],
        summary: 'Send a code to confirm a new phone number',
        description:
          'For a driver that signs in with SMS codes (any other driver, or the current number, answers 400 VALIDATION_ERROR): after the fresh proof of the driver, texts a code to the new number and returns its challengeId. Send it as phoneVerification with the phone on PATCH /v1/portal/driver/profile. The code is bound to that number and works once, for 5 minutes; at most 5 codes in 15 minutes per driver and 3 an hour per number across accounts (429 MFA_RESEND_LIMITED).',
        operationId: 'portalStartPhoneVerification',
        security: [{ bearerAuth: [] }],
        body: zodSchema(phoneVerificationStartBody),
        response: {
          200: itemResponse(
            z
              .object({ challengeId: z.number().int().describe('Send it back with the code') })
              .passthrough(),
          ),
          400: errorWith(
            'No number, or the proof is missing or wrong',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.INVALID_PASSWORD,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
            ],
            {
              proofKinds: z
                .array(z.enum(FACTOR_PROOF_KINDS))
                .optional()
                .describe('A missing or wrong proof: the proof kinds the driver accepts'),
            },
          ),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
          429: errorWith('Too many codes sent', [ERROR_CODES.MFA_RESEND_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof phoneVerificationStartBody>;
      const phoneIn = readPhoneInput(body.phone);
      if (phoneIn.kind !== 'number') {
        await reply.status(400).send(INVALID_PHONE_REPLY);
        return;
      }
      const { phone } = phoneIn;
      const [driver] = await db
        .select({
          firstName: drivers.firstName,
          language: drivers.language,
          phone: drivers.phone,
          mfaEnabled: drivers.mfaEnabled,
          mfaMethod: drivers.mfaMethod,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      // Checked before the proof, so a refused request spends none.
      const notSent = phoneVerificationRefusal(driver, phone);
      if (notSent != null) {
        await reply.status(400).send({ error: notSent, code: 'VALIDATION_ERROR' });
        return;
      }
      const refused = await checkFactorProof(request, { driverId }, body.proof);
      if (refused != null) {
        await sendFactorProofRefusal(reply, refused);
        return;
      }
      const challenge = await createAccountMfaChallenge({ driverId }, PHONE_CHANGE_METHOD, {
        purpose: 'setup',
        destination: phone,
      });
      if (isMfaChallengeLimited(challenge)) {
        await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
        return;
      }
      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        {
          phone,
          language: driver.language,
          firstName: driver.firstName,
        },
        { code: challenge.code },
        ALL_TEMPLATES_DIRS,
      );
      return { challengeId: challenge.challengeId };
    },
  );

  app.patch(
    '/portal/driver/billing-address',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Update the authenticated driver billing address',
        description:
          'Sets the bill-to block of the invoices a fleet addresses to the driver. Fields left out keep their value; null or a blank string clears a field. A change is audited; a request that changes nothing is not.',
        operationId: 'portalUpdateBillingAddress',
        security: [{ bearerAuth: [] }],
        body: zodSchema(driverBillingAddressBody),
        response: {
          200: itemResponse(driverBillingAddressItem),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof driverBillingAddressBody>;
      return updateDriverBillingAddress(driverId, body, {
        actor: getAuditActor(request),
        log: request.log,
      });
    },
  );

  app.patch(
    '/portal/driver/password',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Change the authenticated driver password',
        description:
          'Changes the password and ends every session of the driver, then starts a new session for this client: new auth cookies for the web, or { success, token, refreshToken, expiresIn } for a mobile client (X-Client: mobile). Other devices sign in again.',
        operationId: 'portalChangePassword',
        security: [{ bearerAuth: [] }],
        body: zodSchema(changePasswordBody),
        response: {
          200: successResponse,
          400: errorWith(
            'Weak or wrong password',
            [ERROR_CODES.WEAK_PASSWORD, ERROR_CODES.INVALID_PASSWORD],
            weakPasswordFields,
          ),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
        },
      },
      // Tight bucket so a stolen session cannot guess the current password,
      // like DELETE /portal/driver/mfa.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof changePasswordBody>;

      const [driver] = await db
        .select({ passwordHash: drivers.passwordHash, loginLockedUntil: drivers.loginLockedUntil })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      if (driver == null || driver.passwordHash == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      const valid = await checkCurrentPassword(request, { driverId }, driver, body.currentPassword);
      if (!valid) {
        await reply
          .status(400)
          .send({ error: 'Current password is incorrect', code: 'INVALID_PASSWORD' });
        return;
      }

      const weakPassword = await validatePassword(body.newPassword);
      if (weakPassword != null) {
        await reply.status(400).send(weakPassword);
        return;
      }

      const newHash = await argon2.hash(body.newPassword);
      await db
        .update(drivers)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(drivers.id, driverId));

      // End every session, then give this client a new one, like the
      // operator password change: other devices sign in again.
      await endDriverSessions(driverId);
      const tokens = await issueDriverTokens(app, request, reply, driverId);

      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
        {
          entityId: driverId,
          entityIdSnapshot: driverId,
          action: 'password_reset',
          ...getAuditActor(request),
          notes: 'Driver changed own password',
        },
        db,
        request.log,
      );

      void dispatchDriverNotification(
        client,
        'driver.PasswordChanged',
        driverId,
        {},
        ALL_TEMPLATES_DIRS,
        getPubSub(),
      );

      return tokens == null ? { success: true } : { success: true, ...tokens };
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
          pushEnabled: driverNotificationPreferences.pushEnabled,
        })
        .from(driverNotificationPreferences)
        .where(eq(driverNotificationPreferences.driverId, driverId));

      if (row == null) {
        return { emailEnabled: true, smsEnabled: true, pushEnabled: true };
      }

      return {
        emailEnabled: row.emailEnabled,
        smsEnabled: row.smsEnabled,
        pushEnabled: row.pushEnabled,
      };
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

      const [existing] = await db
        .select({
          emailEnabled: driverNotificationPreferences.emailEnabled,
          smsEnabled: driverNotificationPreferences.smsEnabled,
          pushEnabled: driverNotificationPreferences.pushEnabled,
        })
        .from(driverNotificationPreferences)
        .where(eq(driverNotificationPreferences.driverId, driverId));
      // pushEnabled is optional: a client that does not manage native push (the
      // web portal) omits it, and we must not clobber a value the mobile app set.
      const pushEnabled = body.pushEnabled ?? existing?.pushEnabled ?? true;

      await db
        .insert(driverNotificationPreferences)
        .values({
          driverId,
          emailEnabled: body.emailEnabled,
          smsEnabled: body.smsEnabled,
          pushEnabled,
        })
        .onConflictDoUpdate({
          target: driverNotificationPreferences.driverId,
          set: {
            emailEnabled: body.emailEnabled,
            smsEnabled: body.smsEnabled,
            pushEnabled,
            updatedAt: new Date(),
          },
        });

      const next = { emailEnabled: body.emailEnabled, smsEnabled: body.smsEnabled, pushEnabled };
      // A driver without a stored row has every channel on.
      const prev = existing ?? { emailEnabled: true, smsEnabled: true, pushEnabled: true };
      const diff = changedFields(prev, next);
      if (Object.keys(diff.after).length > 0) {
        await writeAudit(
          { table: driverAuditLog, idColumn: 'driver_id' },
          {
            entityId: driverId,
            entityIdSnapshot: driverId,
            action: 'updated',
            ...getAuditActor(request),
            before: { notificationPreferences: diff.before },
            after: { notificationPreferences: diff.after },
            notes: 'Notification preferences updated in the driver portal',
          },
          db,
          request.log,
        );
      }

      return next;
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
        .describe(
          'MFA methods the driver can turn on: enabled by the administrator (totp, email, sms), email only with an email address and sms only with a phone number',
        ),
      recoveryCodesRemaining: z
        .number()
        .int()
        .describe('Unused recovery codes of the driver (0 without MFA)'),
      recoveryCodesUsedUp: z
        .boolean()
        .describe(
          'True when the driver used every recovery code it was given (time to generate new ones); false when there are codes left or there never were any',
        ),
      requiredByPolicy: z
        .boolean()
        .describe(
          'Required MFA covers drivers (Settings > Security > MFA), so MFA cannot be turned off; also true while the MFA settings cannot be read',
        ),
      passkeyCount: z.number().int().describe('Passkeys and security keys of the driver'),
      webauthnEnabled: z
        .boolean()
        .describe('Passkeys and security keys are allowed (Settings > Security > MFA)'),
      passkeyLoginEnabled: z
        .boolean()
        .describe('Passwordless sign-in with a passkey is allowed (needs webauthnEnabled)'),
      factorProofKinds: z
        .array(z.enum(FACTOR_PROOF_KINDS))
        .describe(
          'The proofs adding a factor accepts (proof on the passkey registration and the MFA confirm): the factor kinds the driver holds, else password',
        ),
      lastFactorIsPasskey: z
        .boolean()
        .describe(
          'True when the only factor is one passkey (no email, SMS or TOTP method): removing it turns MFA off and needs a proof (lastFactorProofKinds)',
        ),
      lastFactorProofKinds: z
        .array(z.enum(FACTOR_PROOF_KINDS))
        .describe(
          'Proofs that removing a factor (DELETE /v1/portal/driver/webauthn/:id) or turning MFA off (DELETE /v1/portal/driver/mfa) accepts: the factor kinds of factorProofKinds plus recovery_code while recovery codes remain; never password while the account holds a factor',
        ),
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
        .select({
          mfaEnabled: drivers.mfaEnabled,
          mfaMethod: drivers.mfaMethod,
          email: drivers.email,
          phone: drivers.phone,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      const mfaConfig = await getMfaConfig();
      const contact = { email: driver?.email ?? null, phone: driver?.phone ?? null };
      const availableMethods: string[] = [];
      if (mfaConfig.emailEnabled && hasMfaContact('email', contact)) {
        availableMethods.push('email');
      }
      if (mfaConfig.totpEnabled) availableMethods.push('totp');
      if (mfaConfig.smsEnabled && hasMfaContact('sms', contact)) {
        availableMethods.push('sms');
      }

      const counts = await mfaFactorCounts({ driverId });
      const protectedByMfa =
        driver != null &&
        hasMfa({ mfaEnabled: driver.mfaEnabled, mfaMethod: driver.mfaMethod, ...counts });
      const proofAccount = await proofAccountOf({ driverId });
      return {
        mfaEnabled: driver?.mfaEnabled ?? false,
        mfaMethod: driver?.mfaMethod ?? null,
        availableMethods,
        recoveryCodesRemaining: protectedByMfa ? await countRecoveryCodes({ driverId }) : 0,
        recoveryCodesUsedUp: protectedByMfa ? await recoveryCodesUsedUp({ driverId }) : false,
        requiredByPolicy: (await driverMfaPolicy()) !== 'not_required',
        passkeyCount: counts.passkeyCount,
        webauthnEnabled: mfaConfig.webauthnEnabled,
        passkeyLoginEnabled: mfaConfig.webauthnEnabled && mfaConfig.passkeyLoginEnabled,
        factorProofKinds: proofAccount != null ? factorProofKindsOf(proofAccount) : [],
        lastFactorIsPasskey: driver?.mfaEnabled !== true && counts.passkeyCount === 1,
        lastFactorProofKinds: proofAccount != null ? lastFactorProofKindsOf(proofAccount) : [],
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
      onRequest: [authenticateDriverOrMfaEnrollment(app)],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Driver'],
        summary: 'Start MFA setup',
        description:
          'Begins MFA setup for the method: TOTP returns the secret and a QR code, email or SMS sends a code and returns its challengeId. Nothing is active until the confirm step. A driver with a primary method answers 409 MFA_ALREADY_ENABLED; a driver with passkeys only may add one. Takes a session, or the enrollmentToken of a portal sign-in that answered mfaEnrollmentRequired.',
        operationId: 'portalSetupMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaSetupBody),
        response: {
          200: itemResponse(mfaSetupResponse),
          400: errorWith('Driver not found or no contact for the method', [
            ERROR_CODES.DRIVER_NOT_FOUND,
            ERROR_CODES.VALIDATION_ERROR,
          ]),
          401: errorWith('Unauthorized', [
            ERROR_CODES.UNAUTHORIZED,
            ERROR_CODES.ACCOUNT_DEACTIVATED,
          ]),
          403: errorWith('MFA method disabled', [ERROR_CODES.MFA_METHOD_DISABLED]),
          409: errorResponse,
          429: errorWith('Too many codes sent', [ERROR_CODES.MFA_RESEND_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { method } = request.body as z.infer<typeof mfaSetupBody>;
      const enrolling = isDriverMfaEnrollmentRequest(request);

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
      // login. Force them through disable (password-gated) first. An enrollment token is
      // accepted only while the driver has no usable factor, so its old secret is no longer trusted.
      if (driver.mfaEnabled && !enrolling) {
        await reply
          .status(409)
          .send({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
        return;
      }

      // A code sent to nothing would leave the driver unable to confirm.
      if (!hasMfaContact(method, driver)) {
        await reply.status(400).send({
          error:
            method === 'sms'
              ? 'Add a phone number before you turn on SMS codes'
              : 'Add an email address before you turn on email codes',
          code: 'VALIDATION_ERROR',
        });
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

      // An SMS code goes to a number the driver has not proven yet: the code is bound
      // to it and every account's codes to that number count toward its cap.
      const challenge = await createAccountMfaChallenge({ driverId }, method, {
        purpose: 'setup',
        destination: mfaCodeDestination(method, driver),
      });
      if (isMfaChallengeLimited(challenge)) {
        await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
        return;
      }

      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        mfaCodeRecipient(method, driver),
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
    proof: factorProof
      .optional()
      .describe(
        'With a session: fresh proof of the driver (a factor it holds, such as a passkey, see POST /v1/portal/driver/mfa/factor-proof, else its password; a driver with neither is refused). A Bearer request without a portal session (the mobile app) needs it only when the driver already has a factor. Not needed with the enrollmentToken',
      ),
  });

  const mfaConfirmResponse = z
    .object({
      success: z.literal(true).describe('MFA is on'),
      recoveryCodes: z
        .array(z.string())
        .optional()
        .describe(
          'Ten single-use recovery codes (xxxxx-xxxxx), returned this once; absent when the driver already has codes (passkeys only), which stay valid',
        ),
      driver: z
        .object({
          id: z.string().describe('Driver ID'),
          email: z.string().nullable().describe('Email address'),
          firstName: z.string().nullable().describe('First name'),
          lastName: z.string().nullable().describe('Last name'),
        })
        .passthrough()
        .optional()
        .describe(
          'With an enrollmentToken: the driver now signed in (session cookies, or tokens for a mobile client)',
        ),
      ...{
        token: z.string().optional().describe('Access JWT, mobile clients only'),
        refreshToken: z.string().optional().describe('Opaque refresh token, mobile clients only'),
        expiresIn: z.number().int().optional().describe('Access token lifetime in seconds'),
      },
    })
    .passthrough();

  const proofKindsField = z
    .array(z.enum(FACTOR_PROOF_KINDS))
    .optional()
    .describe('VALIDATION_ERROR of a missing or wrong proof: the proof kinds the driver accepts');

  app.post(
    '/portal/driver/mfa/confirm',
    {
      onRequest: [authenticateDriverOrMfaEnrollment(app)],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Confirm MFA setup with verification code',
        description:
          'Verifies the code of the MFA setup, turns MFA on and returns ten single-use recovery codes, shown this once; a driver that already has codes (passkeys only) keeps them. With a cookie session (the portal) the driver proves itself in proof: a factor it holds, else its password, else nothing; a request authenticated by a token issued to the mobile app needs the proof only when the driver already has a factor. A missing or wrong kind answers 400 VALIDATION_ERROR with proofKinds. With a session it ends every other session of the driver and starts a new one for this client (new cookies, or token, refreshToken and expiresIn for a mobile client). With the enrollmentToken of a sign-in that answered mfaEnrollmentRequired, it also signs the driver in (session cookies, driver), ends every other session of the driver and the token stops working.',
        operationId: 'portalConfirmMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaConfirmBody),
        response: {
          200: itemResponse(mfaConfirmResponse),
          400: errorWith(
            'Bad request, or the proof is missing or wrong',
            [
              ERROR_CODES.INVALID_PASSWORD,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.TOTP_NOT_CONFIGURED,
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
            ],
            { proofKinds: proofKindsField },
          ),
          401: errorWith('Unauthorized', [
            ERROR_CODES.UNAUTHORIZED,
            ERROR_CODES.ACCOUNT_DEACTIVATED,
          ]),
          403: errorWith('MFA method disabled', [ERROR_CODES.MFA_METHOD_DISABLED]),
          409: errorWith('MFA is already enabled', [ERROR_CODES.MFA_ALREADY_ENABLED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { method, code, challengeId, proof } = request.body as z.infer<typeof mfaConfirmBody>;
      const enrolling = isDriverMfaEnrollmentRequest(request);

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
          totpSecretEnc: drivers.totpSecretEnc,
          mfaEnabled: drivers.mfaEnabled,
          phone: drivers.phone,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      // Switching the method of an active MFA goes through disable (password
      // gated) and setup, like the setup step itself. An enrollment token
      // replaces a switched-off method that was the only factor.
      if (driver?.mfaEnabled === true && !enrolling) {
        await reply
          .status(409)
          .send({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
        return;
      }

      // A stolen session cannot add a factor: it must prove the driver first. The portal
      // always proves it, the password for a driver without a factor. A Bearer token issued
      // to the mobile app (which sends no proof yet) proves it only when the driver already
      // has a factor; a portal cookie resent as a Bearer token has no mobile claim.
      if (!enrolling) {
        const proofAccount = await proofAccountOf({ driverId });
        const hasFactor = proofAccount != null && holdsFactor(factorProofKindsOf(proofAccount));
        if (proof != null || hasFactor || !isMobileSession(request)) {
          const refused = await checkFactorProof(request, { driverId }, proof);
          if (refused != null) {
            await sendFactorProofRefusal(reply, refused);
            return;
          }
        }
      }

      let verified = false;
      let totpStep: number | null = null;
      if (method === 'totp') {
        if (driver?.totpSecretEnc == null) {
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
        const encKey = apiConfig.SETTINGS_ENCRYPTION_KEY;
        try {
          const secret = decryptString(driver.totpSecretEnc, encKey);
          totpStep = matchTotpStep(secret, code);
          verified = totpStep != null;
        } catch (err: unknown) {
          // Mirror the /portal/auth/mfa/verify path: a corrupted ciphertext
          // or rotated SETTINGS_ENCRYPTION_KEY would otherwise surface as a
          // raw 500. Return a clean 400 and log the root cause.
          request.log.warn({ err, driverId }, 'TOTP secret decrypt failed');
          await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
          return;
        }
      } else if (challengeId != null) {
        // The code must have been sent for the method being confirmed, and an SMS
        // code to the number the driver has now.
        verified =
          (await verifyMfaChallenge(client, challengeId, code, {
            driverId,
            method,
            purpose: 'setup',
            destination: mfaCodeDestination(method, { phone: driver?.phone ?? null }),
          })) === 'verified';
      }

      if (!verified) {
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }

      // The confirming TOTP code cannot be replayed at the next sign-in. With an
      // enrollment token the same UPDATE raises the session version only while it
      // is still the token's, so of two parallel confirms one wins and the new
      // version ends the token.
      const enabledColumns = {
        mfaEnabled: true,
        mfaMethod: method,
        totpLastStep: totpStep,
        mfaFailedCount: 0,
        mfaLockedUntil: null,
        updatedAt: new Date(),
      };
      if (enrolling) {
        const sv = (request.user as { sv?: unknown }).sv;
        const [enabled] = await db
          .update(drivers)
          .set({ ...enabledColumns, sessionVersion: sql`${drivers.sessionVersion} + 1` })
          .where(
            and(
              eq(drivers.id, driverId),
              eq(drivers.sessionVersion, typeof sv === 'number' ? sv : 0),
            ),
          )
          .returning({ id: drivers.id });
        if (enabled == null) {
          // Another confirm with the same enrollment token won: it already signed the driver in.
          await reply.status(401).send({ error: 'Session ended', code: 'UNAUTHORIZED' });
          return;
        }
      } else {
        await db.update(drivers).set(enabledColumns).where(eq(drivers.id, driverId));
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
        {
          entityId: driverId,
          entityIdSnapshot: driverId,
          action: 'mfa_enabled',
          ...actor,
          after: { mfaMethod: method },
        },
        db,
        request.log,
      );
      // A passkey-only driver already had MFA: the method is an added factor.
      const passkeysBefore = await countWebauthnCredentials({ driverId });
      sendSecurityNotice(
        { driverId },
        'security.FactorAdded',
        { mfaTurnedOn: passkeysBefore === 0, ...factorFlags(method) },
        request.log,
      );

      // A driver with passkeys already holds recovery codes: they stay valid.
      const recoveryCodes =
        (await countRecoveryCodes({ driverId })) > 0
          ? undefined
          : await issueRecoveryCodes({ driverId }, 'generated', { actor, log: request.log });
      if (!enrolling) {
        // Turning MFA on ends every other session of the driver, as for operators, so a
        // session taken before cannot outlive the new factor; this client gets new tokens.
        await endDriverSessions(driverId);
        const tokens = await issueDriverTokens(app, request, reply, driverId);
        return {
          success: true as const,
          ...(recoveryCodes != null ? { recoveryCodes } : {}),
          ...(tokens ?? {}),
        };
      }

      // The enrollment finishes the sign-in that required it.
      // The token's sign-in ends every other session of the driver, refresh tokens included.
      await endDriverSessions(driverId);
      await recordAuthAudit(request, {
        kind: 'driver',
        accountId: driverId,
        action: 'login_succeeded',
        method: 'mfa_enrollment',
      });
      const [signedIn] = await db
        .select(driverSessionColumns)
        .from(drivers)
        .where(eq(drivers.id, driverId));
      await issueDriverSession(app, request, reply, signedIn ?? { id: driverId }, {
        extra: { success: true, ...(recoveryCodes != null ? { recoveryCodes } : {}) },
      });
      return;
    },
  );

  const mfaDisableBody = z.object({
    proof: factorProof
      .optional()
      .describe(
        'Fresh proof of a factor the driver holds (TOTP, an emailed or texted code, a passkey) or one of its recovery codes: the kinds GET /v1/portal/driver/mfa lists in lastFactorProofKinds. The password alone is not enough while the driver holds a factor',
      ),
  });

  app.delete(
    '/portal/driver/mfa',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Disable MFA',
        description:
          'Turns MFA off after a fresh proof of a factor the driver holds or a recovery code (proof, kinds in lastFactorProofKinds of GET /v1/portal/driver/mfa; the password alone is not accepted while the driver holds a factor), removes the recovery codes and the passkeys and security keys of the driver, and ends every session of the driver, then starts a new session for this client: new auth cookies for the web, or { success, token, refreshToken, expiresIn } for a mobile client (X-Client: mobile). A mobile app request without a proof answers 400 VALIDATION_ERROR with portalUrl: turn MFA off in the driver portal. A missing proof answers 400 VALIDATION_ERROR with proofKinds, a wrong one MFA_CODE_INVALID, MFA_CHALLENGE_EXHAUSTED, WEBAUTHN_CHALLENGE_EXPIRED or WEBAUTHN_VERIFICATION_FAILED. While required MFA covers drivers it answers 409 MFA_REQUIRED_BY_POLICY (503 MFA_POLICY_UNAVAILABLE when the MFA settings cannot be read).',
        operationId: 'portalDisableMfa',
        security: [{ bearerAuth: [] }],
        body: zodSchema(mfaDisableBody),
        response: {
          200: successResponse,
          400: errorWith(
            'Bad request',
            [
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.DRIVER_NOT_FOUND,
              ERROR_CODES.INVALID_PASSWORD,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
            ],
            {
              proofKinds: z
                .array(z.enum(FACTOR_PROOF_KINDS))
                .optional()
                .describe(
                  'VALIDATION_ERROR of a missing or wrong proof: the proof kinds the driver accepts',
                ),
              portalUrl: z
                .string()
                .optional()
                .describe('VALIDATION_ERROR of a mobile app request: the driver portal to use'),
            },
          ),
          409: errorWith('Required MFA covers drivers', [ERROR_CODES.MFA_REQUIRED_BY_POLICY]),
          503: errorWith('MFA settings unavailable', [ERROR_CODES.MFA_POLICY_UNAVAILABLE]),
        },
      },
      // Tight bucket so a stolen session token cannot guess the proof by
      // spamming this endpoint. Parity with the operator MFA DELETE.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { proof } = request.body as z.infer<typeof mfaDisableBody>;

      const [driver] = await db
        .select({
          passwordHash: drivers.passwordHash,
          mfaMethod: drivers.mfaMethod,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));

      if (driver == null || driver.passwordHash == null) {
        await reply.status(400).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }

      // Required MFA keeps MFA on, and fails closed while the settings cannot be read.
      const policy = await driverMfaPolicy();
      if (policy === 'unavailable') {
        request.log.error(
          { driverId },
          'The MFA settings could not be read, so required MFA refuses the request',
        );
        await reply.status(503).send({
          error: 'The MFA policy could not be read. Try again later.',
          code: 'MFA_POLICY_UNAVAILABLE',
        });
        return;
      }
      if (policy === 'required') {
        await reply.status(409).send({
          error: 'MFA is required for drivers and cannot be turned off',
          code: 'MFA_REQUIRED_BY_POLICY',
        });
        return;
      }

      // The mobile app sends only the password, which no longer turns MFA off while the
      // driver holds a factor: point it at the portal, which asks for the factor.
      if (proof == null && isMobileSession(request)) {
        const error = `Turn off two-factor authentication in the driver portal at ${apiConfig.PORTAL_URL}`;
        await reply.status(400).send({
          error,
          code: 'VALIDATION_ERROR',
          portalUrl: apiConfig.PORTAL_URL,
        });
        return;
      }
      // A factor or a recovery code, never the password alone: a stolen session with a
      // phished password must not strip the factors that protect the account.
      const refused = await checkFactorProof(request, { driverId }, proof, 'remove');
      if (refused != null) {
        await sendFactorProofRefusal(reply, refused);
        return;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(drivers)
          .set({
            mfaEnabled: false,
            mfaMethod: null,
            totpSecretEnc: null,
            totpLastStep: null,
            updatedAt: new Date(),
          })
          .where(eq(drivers.id, driverId));
        await deleteRecoveryCodes({ driverId }, tx);
        await deleteWebauthnCredentials({ driverId }, tx);
      });

      await writeAudit(
        { table: driverAuditLog, idColumn: 'driver_id' },
        {
          entityId: driverId,
          entityIdSnapshot: driverId,
          action: 'mfa_disabled',
          ...getAuditActor(request),
          before: { mfaMethod: driver.mfaMethod },
        },
        db,
        request.log,
      );

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

      // End every other session, then give this client a new one, like the operator MFA disable.
      await endDriverSessions(driverId);
      const tokens = await issueDriverTokens(app, request, reply, driverId);
      return { success: true as const, ...(tokens ?? {}) };
    },
  );

  const recoveryCodesBody = z.object({
    code: z
      .string()
      .min(6)
      .max(6)
      .optional()
      .describe(
        'Code of the current MFA method. For email or SMS, omit it first to have a code sent',
      ),
    challengeId: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Challenge ID of the email or SMS code'),
    credential: authenticationCredential
      .optional()
      .describe(
        'A passkey or security key as the proof instead of a code: the navigator.credentials.get response to POST /v1/portal/driver/mfa/recovery-codes/webauthn-options',
      ),
  });

  const recoveryCodesResponse = z
    .object({
      recoveryCodes: z
        .array(z.string())
        .optional()
        .describe('Ten new single-use recovery codes (xxxxx-xxxxx), returned this once'),
      challengeId: z
        .number()
        .int()
        .optional()
        .describe('Set when an email or SMS code was sent: send it back with the code'),
    })
    .passthrough();

  app.post(
    '/portal/driver/mfa/recovery-codes',
    {
      onRequest: [app.authenticateDriver],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Driver'],
        summary: 'Replace the MFA recovery codes',
        description:
          'Proves the current MFA method or a passkey, then replaces the recovery codes with ten new ones and returns them this once; the old codes stop working. TOTP: send the code. Email or SMS: a call without code sends one and returns its challengeId, then send code and challengeId. Passkey or security key: send credential, the response to POST /v1/portal/driver/mfa/recovery-codes/webauthn-options. A wrong code counts toward the driver MFA backoff, and while it locks the driver a code is refused unchecked.',
        operationId: 'portalRegenerateMfaRecoveryCodes',
        security: [{ bearerAuth: [] }],
        body: zodSchema(recoveryCodesBody),
        response: {
          200: itemResponse(recoveryCodesResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_CODE_INVALID,
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.TOTP_NOT_CONFIGURED,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
            ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
          ]),
          429: errorWith('Too many codes sent', [ERROR_CODES.MFA_RESEND_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { code, challengeId, credential } = request.body as z.infer<typeof recoveryCodesBody>;

      // A driver with passkeys only has no method to send or check a code: its passkey is the proof.
      if (credential != null) {
        if (code != null) {
          await reply
            .status(400)
            .send({ error: 'Send a code or a passkey, not both', code: 'VALIDATION_ERROR' });
          return;
        }
        const proof = await verifyRecoveryCodesPasskey(
          request,
          { driverId },
          credential as unknown as AuthenticationResponseJSON,
        );
        if (proof === 'challenge_expired') {
          await reply.status(400).send({
            error: 'The passkey request expired or was already used',
            code: 'WEBAUTHN_CHALLENGE_EXPIRED',
          });
          return;
        }
        if (proof === 'failed') {
          await reply.status(400).send({
            error: 'The passkey or security key could not be verified',
            code: 'WEBAUTHN_VERIFICATION_FAILED',
          });
          return;
        }
        const recoveryCodes = await issueRecoveryCodes({ driverId }, 'regenerated', {
          actor: getAuditActor(request),
          log: request.log,
        });
        return { recoveryCodes };
      }

      const [driver] = await db
        .select({
          mfaEnabled: drivers.mfaEnabled,
          mfaMethod: drivers.mfaMethod,
          totpSecretEnc: drivers.totpSecretEnc,
          email: drivers.email,
          phone: drivers.phone,
          firstName: drivers.firstName,
          language: drivers.language,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      if (driver == null || !driver.mfaEnabled || driver.mfaMethod == null) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }

      if (code == null) {
        if (driver.mfaMethod === 'totp') {
          await reply.status(400).send({
            error: 'Send the code from your authenticator app',
            code: 'VALIDATION_ERROR',
          });
          return;
        }
        const challenge = await createAccountMfaChallenge({ driverId }, driver.mfaMethod, {
          purpose: 'proof',
          destination: mfaCodeDestination(driver.mfaMethod, driver),
          destinationProven: true,
        });
        if (isMfaChallengeLimited(challenge)) {
          await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
          return;
        }
        await dispatchSystemNotification(
          client,
          'mfa.VerificationCode',
          mfaCodeRecipient(driver.mfaMethod, driver),
          { code: challenge.code },
          ALL_TEMPLATES_DIRS,
        );
        return { challengeId: challenge.challengeId };
      }

      if (driver.mfaMethod === 'totp' && driver.totpSecretEnc == null) {
        await reply.status(400).send({ error: 'TOTP not set up', code: 'TOTP_NOT_CONFIGURED' });
        return;
      }
      // While the proof backoff locks the driver the code is not checked, as in the factor
      // proof. The try is counted in the UPDATE that checks the lock, so parallel guesses
      // cannot pass it; it counts apart from sign-in, so wrong guesses never lock the sign-in.
      const attempt = await takeSignInAttempt({ driverId }, 'proof');
      if (!attempt.granted) {
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }

      let verified = false;
      if (driver.mfaMethod === 'totp' && driver.totpSecretEnc != null) {
        let step: number | null = null;
        try {
          step = matchTotpStep(
            decryptString(driver.totpSecretEnc, apiConfig.SETTINGS_ENCRYPTION_KEY),
            code,
          );
        } catch (err: unknown) {
          request.log.warn({ err, driverId }, 'TOTP secret decrypt failed');
        }
        // A code is accepted once, as at sign-in.
        if (step != null) verified = await acceptTotpStep({ driverId }, step);
      } else if (challengeId != null) {
        verified =
          (await verifyMfaChallenge(client, challengeId, code, {
            driverId,
            method: driver.mfaMethod,
            purpose: 'proof',
            destination: mfaCodeDestination(driver.mfaMethod, driver),
          })) === 'verified';
      }
      if (!verified) {
        await recordAttemptFailure(request, attempt);
        await reply
          .status(400)
          .send({ error: 'Invalid verification code', code: 'MFA_CODE_INVALID' });
        return;
      }
      await clearSignInFailures({ driverId }, 'proof');

      const recoveryCodes = await issueRecoveryCodes({ driverId }, 'regenerated', {
        actor: getAuditActor(request),
        log: request.log,
      });
      return { recoveryCodes };
    },
  );
}
