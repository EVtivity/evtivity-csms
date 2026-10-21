// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { MFA_FACTORS } from './mfa-factors.js';

/** The reply of every operator sign-in step: a session, the MFA step, or MFA enrollment. */
export const loginResponse = z
  .object({
    token: z
      .string()
      .optional()
      .describe(
        'Operator JWT (kept for backward compatibility; cookies are the primary transport)',
      ),
    user: z
      .object({
        id: z.string().describe('User identifier'),
        email: z.string().describe('Email address'),
        firstName: z.string().nullable().describe('First name'),
        lastName: z.string().nullable().describe('Last name'),
        language: z.string().describe('Preferred UI language code'),
        timezone: z.string().optional().describe('IANA timezone identifier'),
      })
      .passthrough()
      .optional()
      .describe('Authenticated user, omitted when MFA is required'),
    role: z
      .object({
        id: z.string().describe('Role identifier'),
        name: z.string().describe('Role display name'),
      })
      .passthrough()
      .nullable()
      .optional()
      .describe('Role assigned to the user'),
    mfaRequired: z
      .boolean()
      .optional()
      .describe('Whether the user must complete MFA before authentication finishes'),
    mfaMethod: z
      .string()
      .optional()
      .describe('MFA method to use (email, sms, totp; passkey when a passkey is the only factor)'),
    mfaToken: z
      .string()
      .optional()
      .describe('Short-lived MFA pending token to send with the verify request'),
    challengeId: z
      .number()
      .optional()
      .describe('Identifier of the email/SMS challenge created for the user'),
    mustResetPassword: z
      .boolean()
      .optional()
      .describe('Whether the user must reset their password before continuing'),
    mfaEnrollmentRequired: z
      .boolean()
      .optional()
      .describe(
        'The user must set up MFA before a session is issued: required MFA covers the user, or the method used is switched off and was the only factor. Comes with enrollmentToken and availableMethods instead of a session',
      ),
    enrollmentToken: z
      .string()
      .optional()
      .describe(
        'With mfaEnrollmentRequired: a 10-minute token, sent as Authorization Bearer to POST /v1/users/me/mfa/setup and /confirm and POST /v1/users/me/webauthn/registration-options and /registration only; every other route answers 401 MFA_ENROLLMENT_REQUIRED',
      ),
    availableMethods: z
      .array(z.enum(['email', 'totp', 'sms']))
      .optional()
      .describe('With mfaEnrollmentRequired: the MFA methods the user can set up'),
    webauthnAvailable: z
      .boolean()
      .optional()
      .describe(
        'With mfaEnrollmentRequired: a passkey or security key can be registered as the factor instead',
      ),
    factors: z
      .array(z.enum(MFA_FACTORS))
      .optional()
      .describe(
        'With mfaRequired: the factors the MFA step accepts (the method while it is usable, recovery_code while recovery codes are left, passkey for a registered passkey or security key: POST /v1/auth/webauthn/options)',
      ),
    mfaMethodDisabled: z
      .boolean()
      .optional()
      .describe(
        'With mfaRequired: the method is switched off by an admin and no code was sent; use a recovery code',
      ),
    recoveryCodesRemaining: z
      .number()
      .int()
      .optional()
      .describe('After MFA with a recovery code: how many unused recovery codes are left'),
  })
  .passthrough();
