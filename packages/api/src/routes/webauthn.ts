// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isMfaChallengeLimited, dispatchSystemNotification } from '@evtivity/lib';
import {
  client,
  db,
  getCompanyName,
  getMfaConfig,
  readMfaConfig,
  roles,
  users,
  userAuditLog,
  writeAudit,
} from '@evtivity/database';
import type { JwtPayload } from '../plugins/auth.js';
import { config as apiConfig } from '../lib/config.js';
import { zodSchema } from '../lib/zod-schema.js';
import {
  arrayResponse,
  errorWith,
  itemResponse,
  successResponse,
} from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { selfService } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { recordAuthAudit } from '../lib/auth-audit.js';
import {
  announceSessionChange,
  endUserSessions,
  issueOperatorSession,
  passwordAuthBlocked,
} from '../lib/operator-session.js';
import { revokeAllUserSessions } from '../services/refresh-token.service.js';
import {
  isMfaEnrollmentRequest,
  mfaPolicyForRole,
  operatorMfaEnrollment,
  selfServiceOrMfaEnrollment,
  sendMfaPolicyUnavailable,
  mfaPendingTokenCurrent,
  sendMfaTokenExpired,
} from '../lib/mfa-enrollment.js';
import { passkeyGate } from '../lib/mfa-factors.js';
import {
  MAX_WEBAUTHN_CREDENTIALS,
  accountUserHandle,
  findWebauthnCredential,
  issueRecoveryCodes,
  listWebauthnCredentials,
  mfaFactorCounts,
  registerWebauthnCredential,
  removeWebauthnCredential,
  renameWebauthnCredential,
  webauthnCredentialsForCeremony,
} from '../services/mfa-factor.service.js';
import {
  WebauthnVerificationError,
  buildAuthenticationOptions,
  buildRegistrationOptions,
  checkRegistration,
  newUserHandle,
  operatorWebauthnRp,
  responseChallenge,
} from '../lib/webauthn.js';
import { saveWebauthnChallenge, takeWebauthnChallenge } from '../lib/webauthn-challenges.js';
import { isChallengeFor, isPasskeyLoginChallenge } from '../lib/webauthn-challenge-records.js';
import {
  authenticationCredential,
  checkFactorProof,
  factorProof,
  factorProofKinds,
  sendFactorProofRefusal,
  verifyAccountAssertion,
} from '../lib/mfa-factor-proof.js';
import { mfaCodeDestination, mfaCodeRecipient } from '../lib/mfa-contact.js';
import { createAccountMfaChallenge, sendMfaResendLimited } from '../lib/sign-in-backoff.js';
import { loginResponse } from '../lib/login-response.js';
import {
  credentialItem,
  credentialName,
  creationOptions,
  defaultCredentialName,
  factorProofBody,
  factorProofResponse,
  idParams,
  passkeyLoginAllowed,
  proofKindsField,
  registrationCredential,
  registrationResponse,
  requestOptions,
  cleanCredentialName,
  sendChallengeExpired,
  sendVerificationFailed,
  serializeCredential,
} from '../lib/webauthn-http.js';

const TEMPLATES_DIR =
  process.env['API_TEMPLATES_DIR'] ??
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

const authRateLimit = {
  rateLimit: { max: apiConfig.AUTH_RATE_LIMIT_MAX, timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW },
};

const registrationBody = z.object({
  credential: registrationCredential,
  name: credentialName
    .optional()
    .describe(
      'Name shown in the list, 1 to 100 characters after control characters are dropped; defaults to Passkey or Security Key',
    ),
  proof: factorProof
    .optional()
    .describe(
      'With a session: fresh proof of the account (its current factor, else its password). Not needed with the enrollmentToken',
    ),
});

const mfaTokenBody = z.object({
  mfaToken: z.string().min(1).describe('The mfaToken of the sign-in that answered mfaRequired'),
});

const secondFactorBody = mfaTokenBody.extend({ credential: authenticationCredential });

type SignedInUser = typeof users.$inferSelect;

async function loginReply(user: SignedInUser, token: string) {
  const [role] = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.id, user.roleId));
  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      language: user.language,
      timezone: user.timezone,
      themePreference: user.themePreference,
    },
    role: role != null ? { id: role.id, name: role.name } : null,
  };
}

/** The MFA pending token of a sign-in, or the reply that refuses it (already sent). */
async function pendingUser(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  mfaToken: string,
): Promise<SignedInUser | null> {
  let payload: { userId?: string; mfaPending?: boolean };
  try {
    payload = app.jwt.verify(mfaToken);
  } catch (err) {
    request.log.debug({ err }, 'MFA token did not verify, refusing it');
    await reply
      .status(401)
      .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
    return null;
  }
  if (payload.mfaPending !== true || typeof payload.userId !== 'string') {
    await reply.status(400).send({ error: 'Invalid MFA token', code: 'MFA_TOKEN_INVALID' });
    return null;
  }
  const [user] = await db.select().from(users).where(eq(users.id, payload.userId));
  if (user == null) {
    await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
    return null;
  }
  if (!mfaPendingTokenCurrent(payload, user.sessionVersion)) {
    await sendMfaTokenExpired(reply);
    return null;
  }
  if (!user.isActive) {
    await recordAuthAudit(request, {
      kind: 'user',
      accountId: user.id,
      action: 'login_failed',
      method: 'webauthn',
      reason: 'inactive',
    });
    await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    return null;
  }
  // A passkey signature cannot be guessed, so the MFA lock of wrong codes does not
  // hold the passkey step: a guesser cannot lock the owner out of it.
  return user;
}

async function refuseSecondFactor(
  request: FastifyRequest,
  reply: FastifyReply,
  user: SignedInUser,
  reason: string,
): Promise<void> {
  await recordAuthAudit(request, {
    kind: 'user',
    accountId: user.id,
    action: 'login_failed',
    method: 'webauthn',
    reason,
  });
  await sendVerificationFailed(reply);
}

export function webauthnRoutes(app: FastifyInstance): void {
  // Registration: a signed-in session, or the enrollment token of a sign-in
  // that requires MFA (the passkey is then the enrolled factor).

  app.post(
    '/users/me/webauthn/registration-options',
    {
      onRequest: [selfServiceOrMfaEnrollment()],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Start registering a passkey or security key',
        description:
          'Returns the options for navigator.credentials.create: no attestation, a discoverable credential preferred, user verification preferred, and the credentials already registered excluded. The challenge is valid for 5 minutes and one registration. Takes a session, or the enrollmentToken of a sign-in that answered mfaEnrollmentRequired.',
        operationId: 'getWebauthnRegistrationOptions',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(creationOptions),
          401: errorWith('Unauthorized', [
            ERROR_CODES.UNAUTHORIZED,
            ERROR_CODES.ACCOUNT_DEACTIVATED,
          ]),
          403: errorWith('Passkeys are switched off', [ERROR_CODES.MFA_METHOD_DISABLED]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
          409: errorWith('Too many passkeys', [ERROR_CODES.PASSKEY_LIMIT_REACHED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string };
      if (!(await getMfaConfig()).webauthnEnabled) {
        await reply.status(403).send({
          error: 'Passkeys and security keys are switched off',
          code: 'MFA_METHOD_DISABLED',
        });
        return;
      }
      const [user] = await db
        .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, userId));
      if (user == null) {
        await reply.status(404).send({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }
      const existing = await webauthnCredentialsForCeremony({ userId });
      if (existing.length >= MAX_WEBAUTHN_CREDENTIALS) {
        await reply.status(409).send({
          error: `At most ${String(MAX_WEBAUTHN_CREDENTIALS)} passkeys and security keys`,
          code: 'PASSKEY_LIMIT_REACHED',
        });
        return;
      }
      const userHandle = (await accountUserHandle({ userId })) ?? newUserHandle();
      const displayName = [user.firstName, user.lastName]
        .filter((v) => v != null && v !== '')
        .join(' ');
      const options = await buildRegistrationOptions({
        rp: operatorWebauthnRp(),
        rpName: await getCompanyName(),
        userName: user.email,
        userDisplayName: displayName !== '' ? displayName : user.email,
        userHandle,
        exclude: existing.map((c) => ({ credentialId: c.credentialId, transports: c.transports })),
      });
      await saveWebauthnChallenge(options.challenge, {
        purpose: 'registration',
        userId,
        userHandle,
      });
      return options;
    },
  );

  app.post(
    '/users/me/webauthn/registration',
    {
      onRequest: [selfServiceOrMfaEnrollment()],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Register a passkey or security key',
        description:
          'Verifies the navigator.credentials.create response against the challenge of the registration options, the CSMS origin and the relying party ID, and stores the public key (attestation none). With a session it needs a fresh proof of the account in proof: its current factor when it has one (a TOTP code, an email or SMS code or a passkey, see POST /v1/users/me/mfa/factor-proof), else its password, else a fresh SSO sign-in (sso); an account with none of them is refused. A missing or wrong kind of proof answers 400 VALIDATION_ERROR with the accepted proofKinds. When it is the first factor of the account, it turns MFA on: other sessions end, this browser gets a new one, and ten recovery codes come back, shown this once. With the enrollmentToken it also signs the user in (session cookies, token, user and role) and the token stops working.',
        operationId: 'registerWebauthnCredential',
        security: [{ bearerAuth: [] }],
        body: zodSchema(registrationBody),
        response: {
          200: itemResponse(registrationResponse.merge(loginResponse.partial()).passthrough()),
          400: errorWith(
            'Not verified, or the proof is missing or wrong',
            [
              ERROR_CODES.INVALID_PASSWORD,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.MFA_CODE_INVALID,
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
          403: errorWith('Passkeys are switched off', [ERROR_CODES.MFA_METHOD_DISABLED]),
          404: errorWith('User not found', [ERROR_CODES.USER_NOT_FOUND]),
          409: errorWith('Too many passkeys', [ERROR_CODES.PASSKEY_LIMIT_REACHED]),
        },
      },
    },
    async (request, reply) => {
      const { userId, roleId } = request.user as { userId: string; roleId: string };
      const body = request.body as z.infer<typeof registrationBody>;
      const credential = body.credential as unknown as RegistrationResponseJSON;
      const enrolling = isMfaEnrollmentRequest(request);

      if (!(await getMfaConfig()).webauthnEnabled) {
        await reply.status(403).send({
          error: 'Passkeys and security keys are switched off',
          code: 'MFA_METHOD_DISABLED',
        });
        return;
      }
      const name =
        body.name != null ? cleanCredentialName(body.name) : defaultCredentialName(credential);
      if (name == null) {
        await reply.status(400).send({
          error: 'The name must have 1 to 100 visible characters',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      // A stolen session cannot add a factor: it must prove the account first.
      if (!enrolling) {
        const refused = await checkFactorProof(request, { userId }, body.proof);
        if (refused != null) {
          await sendFactorProofRefusal(reply, refused);
          return;
        }
      }
      const challenge = responseChallenge(credential);
      const record = challenge != null ? await takeWebauthnChallenge(challenge) : null;
      if (challenge == null || !isChallengeFor(record, 'registration', { userId })) {
        await sendChallengeExpired(reply);
        return;
      }

      let verified;
      try {
        verified = await checkRegistration(credential, challenge, operatorWebauthnRp());
      } catch (err) {
        if (!(err instanceof WebauthnVerificationError)) throw err;
        request.log.info({ err: err.cause, userId }, 'WebAuthn registration refused');
        await sendVerificationFailed(reply);
        return;
      }

      const actor = getAuditActor(request);
      const ctx = { actor, log: request.log };
      const registered = await registerWebauthnCredential(
        { userId },
        { ...verified, userHandle: record.userHandle, name },
        ctx,
      );
      if (registered.status === 'limit_reached') {
        await reply.status(409).send({
          error: `At most ${String(MAX_WEBAUTHN_CREDENTIALS)} passkeys and security keys`,
          code: 'PASSKEY_LIMIT_REACHED',
        });
        return;
      }
      if (registered.status === 'duplicate') {
        request.log.info({ userId }, 'WebAuthn credential is already registered');
        await sendVerificationFailed(reply);
        return;
      }
      const { credential: stored, firstFactor } = registered;

      if (enrolling) {
        // The same compare-and-set as the MFA confirm: of two registrations
        // with one enrollment token, one signs in; the new version ends the token.
        const sv = (request.user as { sv?: unknown }).sv;
        const [bumped] = await db
          .update(users)
          .set({
            sessionVersion: sql`${users.sessionVersion} + 1`,
            mfaFailedCount: 0,
            mfaLockedUntil: null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(users.id, userId), eq(users.sessionVersion, typeof sv === 'number' ? sv : 0)),
          )
          .returning({ sessionVersion: users.sessionVersion });
        if (bumped == null) {
          await reply.status(401).send({ error: 'Session ended', code: 'UNAUTHORIZED' });
          return;
        }
        await revokeAllUserSessions(userId);
        announceSessionChange(userId);
        const token = await issueOperatorSession(app, request, reply, {
          id: userId,
          roleId,
          sessionVersion: bumped.sessionVersion,
        });
        await writeMfaEnabledAudit(request, userId);
        const recoveryCodes = await issueRecoveryCodes({ userId }, 'generated', ctx);
        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: userId,
          action: 'login_succeeded',
          method: 'mfa_enrollment',
        });
        const [signedIn] = await db.select().from(users).where(eq(users.id, userId));
        return {
          credential: serializeCredential(stored),
          recoveryCodes,
          ...(signedIn != null ? await loginReply(signedIn, token) : { token }),
        };
      }

      if (!firstFactor) return { credential: serializeCredential(stored) };

      // A first factor turns MFA on: end the other sessions, give this browser a new one.
      const sessionVersion = (await endUserSessions(userId, { apiKeys: false })) ?? 0;
      await issueOperatorSession(app, request, reply, {
        id: userId,
        roleId: (request.user as JwtPayload).roleId,
        sessionVersion,
      });
      await writeMfaEnabledAudit(request, userId);
      const recoveryCodes = await issueRecoveryCodes({ userId }, 'generated', ctx);
      return { credential: serializeCredential(stored), recoveryCodes };
    },
  );

  app.get(
    '/users/me/webauthn',
    {
      onRequest: [selfService({ allowApiKey: true })],
      schema: {
        tags: ['Users'],
        summary: 'List my passkeys and security keys',
        operationId: 'listWebauthnCredentials',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(credentialItem) },
      },
    },
    async (request) => {
      const { userId } = request.user as { userId: string };
      return (await listWebauthnCredentials({ userId })).map(serializeCredential);
    },
  );

  app.patch(
    '/users/me/webauthn/:id',
    {
      onRequest: [selfService()],
      schema: {
        tags: ['Users'],
        summary: 'Rename a passkey or security key',
        operationId: 'renameWebauthnCredential',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(z.object({ name: credentialName.describe('New name') })),
        response: {
          200: itemResponse(credentialItem),
          400: errorWith('Invalid name', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Not found', [ERROR_CODES.PASSKEY_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string };
      const { id } = idParams.parse(request.params);
      const name = cleanCredentialName((request.body as { name: string }).name);
      if (name == null) {
        await reply.status(400).send({
          error: 'The name must have 1 to 100 visible characters',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const row = await renameWebauthnCredential({ userId }, id, name, {
        actor: getAuditActor(request),
        log: request.log,
      });
      if (row == null) {
        await reply.status(404).send({ error: 'Passkey not found', code: 'PASSKEY_NOT_FOUND' });
        return;
      }
      return serializeCredential(row);
    },
  );

  const removeBody = z.object({
    proof: factorProof
      .optional()
      .describe(
        'Fresh proof of a factor the account holds (the passkey itself included) or one of its recovery codes, the kinds GET /v1/users/me/mfa lists in lastFactorProofKinds; never the password alone',
      ),
  });

  app.delete(
    '/users/me/webauthn/:id',
    {
      onRequest: [selfService()],
      // A removal proof can be a code, so a stolen session cannot guess it here.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Remove a passkey or security key',
        description:
          'Send { proof }. Every removal needs a fresh proof of the account: a factor it holds (a TOTP code, an email or SMS code, or a passkey prepared by POST /v1/users/me/mfa/factor-proof) or one of its recovery codes, the kinds GET /v1/users/me/mfa lists in lastFactorProofKinds; never the password alone. Removes the credential and ends the other sessions of the user (this browser gets a new one; API keys stay). When it is the last MFA factor (no email, SMS or TOTP method and no other passkey), MFA turns off and the recovery codes go too. A missing or wrong kind of proof answers 400 VALIDATION_ERROR with the accepted proofKinds; a wrong proof counts toward the account backoff. While required MFA covers the role the removal answers 409 MFA_REQUIRED_BY_POLICY (503 MFA_POLICY_UNAVAILABLE when the MFA settings cannot be read).',
        operationId: 'deleteWebauthnCredential',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(removeBody),
        response: {
          200: successResponse,
          400: errorWith(
            'The proof is missing or wrong',
            [
              ERROR_CODES.INVALID_PASSWORD,
              ERROR_CODES.MFA_CHALLENGE_EXHAUSTED,
              ERROR_CODES.MFA_CODE_INVALID,
              ERROR_CODES.VALIDATION_ERROR,
              ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
              ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
            ],
            { proofKinds: proofKindsField },
          ),
          404: errorWith('Not found', [ERROR_CODES.PASSKEY_NOT_FOUND]),
          409: errorWith('Required MFA covers the user', [ERROR_CODES.MFA_REQUIRED_BY_POLICY]),
          503: errorWith('MFA settings unavailable', [ERROR_CODES.MFA_POLICY_UNAVAILABLE]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string };
      const { id } = idParams.parse(request.params);
      const { proof } = request.body as z.infer<typeof removeBody>;

      // Every removal needs a fresh proof, so a stolen session cannot strip a factor.
      // Checked before the account row lock: a wrong proof counts toward the proof
      // backoff, an UPDATE of the row the lock holds.
      const proofRefusal = await checkFactorProof(request, { userId }, proof, 'remove');
      if (proofRefusal != null) {
        await sendFactorProofRefusal(reply, proofRefusal);
        return;
      }

      // Decided under the account row lock, after a recount: two parallel removals of
      // the last two passkeys cannot both pass as "not the last factor".
      const removed = await removeWebauthnCredential(
        { userId },
        id,
        {
          lastFactorCheck: async () => {
            const [user] = await db
              .select({ roleId: users.roleId })
              .from(users)
              .where(eq(users.id, userId));
            if (user == null) return 'proof_missing' as const;
            const policy = await mfaPolicyForRole(user.roleId);
            if (policy === 'unavailable') return 'policy_unavailable' as const;
            if (policy === 'required') return 'policy_required' as const;
            return null;
          },
        },
        { actor: getAuditActor(request), log: request.log },
      );
      if (removed.status === 'not_found') {
        await reply.status(404).send({ error: 'Passkey not found', code: 'PASSKEY_NOT_FOUND' });
        return;
      }
      if (removed.status === 'refused') {
        if (removed.reason === 'policy_unavailable') {
          await sendMfaPolicyUnavailable(request, reply, userId);
          return;
        }
        if (removed.reason === 'policy_required') {
          await reply.status(409).send({
            error: 'MFA is required for your role: add another factor before removing this one',
            code: 'MFA_REQUIRED_BY_POLICY',
          });
          return;
        }
        await sendFactorProofRefusal(reply, {
          status: 400,
          body: { error: 'Confirm it is you to remove a factor', code: 'VALIDATION_ERROR' },
        });
        return;
      }
      await issueOperatorSession(app, request, reply, {
        id: userId,
        roleId: (request.user as JwtPayload).roleId,
        sessionVersion: removed.sessionVersion ?? 0,
      });
      return { success: true as const };
    },
  );

  // Proof for POST /v1/users/me/mfa/recovery-codes: a passkey of the signed-in user.

  app.post(
    '/users/me/mfa/recovery-codes/webauthn-options',
    {
      onRequest: [selfService()],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Start the passkey proof for new recovery codes',
        description:
          'Returns the options for navigator.credentials.get with the credentials of the signed-in user (user verification preferred). Send the response as credential to POST /v1/users/me/mfa/recovery-codes. The challenge is valid for 5 minutes and one response. Works while passkeys are switched off: the caller is already signed in.',
        operationId: 'getRecoveryCodesWebauthnOptions',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(requestOptions),
          400: errorWith('Bad request', [ERROR_CODES.MFA_NOT_CONFIGURED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string };
      const credentials = await webauthnCredentialsForCeremony({ userId });
      if (credentials.length === 0) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      const options = await buildAuthenticationOptions(operatorWebauthnRp(), {
        userVerification: 'preferred',
        allow: credentials.map((c) => ({ credentialId: c.credentialId, transports: c.transports })),
      });
      await saveWebauthnChallenge(options.challenge, { purpose: 'recovery_regenerate', userId });
      return options;
    },
  );

  // Preparing a proof for adding a factor: an email or SMS code, or a passkey challenge.

  app.post(
    '/users/me/mfa/factor-proof',
    {
      onRequest: [selfService()],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Users'],
        summary: 'Prepare the proof for adding an MFA factor',
        description:
          'Adding a passkey or an MFA method with a session needs a fresh proof of the account (proof on POST /v1/users/me/webauthn/registration and POST /v1/users/me/mfa/confirm). A TOTP code or the password needs no preparation. kind code sends a code to the email or SMS method of the account and returns its challengeId (at most 5 codes in 15 minutes, 429 MFA_RESEND_LIMITED). kind passkey returns the options for navigator.credentials.get with the account credentials (user verification preferred); the challenge is valid for 5 minutes and one response. 400 MFA_NOT_CONFIGURED when the account has no such factor.',
        operationId: 'prepareMfaFactorProof',
        security: [{ bearerAuth: [] }],
        body: zodSchema(factorProofBody),
        response: {
          200: itemResponse(factorProofResponse),
          400: errorWith('Bad request', [ERROR_CODES.MFA_NOT_CONFIGURED]),
          429: errorWith('Too many codes sent', [ERROR_CODES.MFA_RESEND_LIMITED]),
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user as { userId: string };
      const { kind } = request.body as z.infer<typeof factorProofBody>;
      const kinds = await factorProofKinds({ userId });

      if (kind === 'passkey') {
        const credentials = kinds.includes('passkey')
          ? await webauthnCredentialsForCeremony({ userId })
          : [];
        if (credentials.length === 0) {
          await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
          return;
        }
        const options = await buildAuthenticationOptions(operatorWebauthnRp(), {
          userVerification: 'preferred',
          allow: credentials.map((c) => ({
            credentialId: c.credentialId,
            transports: c.transports,
          })),
        });
        await saveWebauthnChallenge(options.challenge, { purpose: 'factor_add', userId });
        return { options };
      }

      const [user] = await db
        .select({
          mfaMethod: users.mfaMethod,
          email: users.email,
          phone: users.phone,
          firstName: users.firstName,
          language: users.language,
        })
        .from(users)
        .where(eq(users.id, userId));
      const method = user?.mfaMethod;
      if (user == null || !kinds.includes('code') || (method !== 'email' && method !== 'sms')) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      const challenge = await createAccountMfaChallenge({ userId }, method, {
        purpose: 'proof',
        destination: mfaCodeDestination(method, user),
        destinationProven: true,
      });
      if (isMfaChallengeLimited(challenge)) {
        await sendMfaResendLimited(reply, challenge.retryAfterSeconds);
        return;
      }
      await dispatchSystemNotification(
        client,
        'mfa.VerificationCode',
        mfaCodeRecipient(method, user),
        { code: challenge.code },
        TEMPLATES_DIR,
      );
      return { challengeId: challenge.challengeId };
    },
  );

  // Second factor: after the password or SSO step, with its mfaPending token.

  app.post(
    '/auth/webauthn/options',
    {
      config: authRateLimit,
      schema: {
        tags: ['Users'],
        summary: 'Start the passkey or security key MFA step',
        description:
          'Takes the mfaToken of a sign-in that answered mfaRequired with passkey among its factors. Returns the options for navigator.credentials.get with the account credentials (user verification preferred, so a security key without a PIN works). The challenge is valid for 5 minutes and one response.',
        operationId: 'getWebauthnMfaOptions',
        security: [],
        body: zodSchema(mfaTokenBody),
        response: {
          200: itemResponse(requestOptions),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.MFA_TOKEN_INVALID,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Forbidden', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.MFA_METHOD_DISABLED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const { mfaToken } = request.body as z.infer<typeof mfaTokenBody>;
      const user = await pendingUser(app, request, reply, mfaToken);
      if (user == null) return;
      const credentials = await webauthnCredentialsForCeremony({ userId: user.id });
      if (credentials.length === 0) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      const counts = await mfaFactorCounts({ userId: user.id });
      if (passkeyGate({ ...user, ...counts }, await readMfaConfig()) === 'refused') {
        await reply.status(403).send({
          error: 'Passkeys and security keys are switched off',
          code: 'MFA_METHOD_DISABLED',
        });
        return;
      }
      const options = await buildAuthenticationOptions(operatorWebauthnRp(), {
        userVerification: 'preferred',
        allow: credentials.map((c) => ({ credentialId: c.credentialId, transports: c.transports })),
      });
      await saveWebauthnChallenge(options.challenge, { purpose: 'second_factor', userId: user.id });
      return options;
    },
  );

  app.post(
    '/auth/webauthn/verify',
    {
      config: authRateLimit,
      schema: {
        tags: ['Users'],
        summary: 'Complete the MFA step with a passkey or security key',
        description:
          'Verifies the navigator.credentials.get response against the challenge of POST /v1/auth/webauthn/options, the CSMS origin, the relying party ID, the stored public key and the signature counter, then issues the session. A response that does not verify counts toward the per-account MFA backoff. When passkeys are switched off and were the only factor, the reply is the enrollment reply instead of a session.',
        operationId: 'verifyWebauthnMfa',
        security: [],
        body: zodSchema(secondFactorBody),
        response: {
          200: zodSchema(loginResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.MFA_TOKEN_INVALID,
            ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
            ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Forbidden', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.MFA_METHOD_DISABLED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof secondFactorBody>;
      const credential = body.credential as unknown as AuthenticationResponseJSON;
      const user = await pendingUser(app, request, reply, body.mfaToken);
      if (user == null) return;

      const reading = await readMfaConfig();
      const counts = await mfaFactorCounts({ userId: user.id });
      if (counts.passkeyCount === 0) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      const gate = passkeyGate({ ...user, ...counts }, reading);
      if (gate === 'refused') {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'webauthn',
          reason: 'mfa_method_disabled',
        });
        await reply.status(403).send({
          error: 'Passkeys and security keys are switched off',
          code: 'MFA_METHOD_DISABLED',
        });
        return;
      }

      const challenge = responseChallenge(credential);
      const record = challenge != null ? await takeWebauthnChallenge(challenge) : null;
      if (challenge == null || !isChallengeFor(record, 'second_factor', { userId: user.id })) {
        await sendChallengeExpired(reply);
        return;
      }

      const stored = await findWebauthnCredential(credential.id);
      if (stored?.userId !== user.id) {
        await refuseSecondFactor(request, reply, user, 'webauthn_unknown_credential');
        return;
      }
      if (
        !(await verifyAccountAssertion(
          request,
          { userId: user.id },
          credential,
          challenge,
          stored,
          false,
        ))
      ) {
        await refuseSecondFactor(request, reply, user, 'webauthn_verification_failed');
        return;
      }
      // Passkeys switched off and the only factor: proven, now set up an allowed one.
      if (gate === 'enrollment_required') {
        const enrollment = operatorMfaEnrollment(app, user, reading.config);
        if (enrollment != null) return enrollment;
      }

      const token = await issueOperatorSession(app, request, reply, user);
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await recordAuthAudit(request, {
        kind: 'user',
        accountId: user.id,
        action: 'login_succeeded',
        method: 'webauthn',
      });
      return loginReply(user, token);
    },
  );

  // Passkey sign-in (D8): no password, the passkey with user verification is both factors.

  app.post(
    '/auth/passkey/options',
    {
      config: authRateLimit,
      schema: {
        tags: ['Users'],
        summary: 'Start a passkey sign-in',
        description:
          'Only while Settings > Security > MFA allows passkey sign-in. Returns the options for navigator.credentials.get without a credential list (the browser offers the discoverable passkeys of the relying party) and with user verification required. The challenge is valid for 5 minutes and one response.',
        operationId: 'getPasskeyLoginOptions',
        security: [],
        response: {
          200: itemResponse(requestOptions),
          403: errorWith('Passkey sign-in is switched off', [ERROR_CODES.MFA_METHOD_DISABLED]),
        },
      },
    },
    async (_request, reply) => {
      if (!(await passkeyLoginAllowed())) {
        await reply
          .status(403)
          .send({ error: 'Passkey sign-in is switched off', code: 'MFA_METHOD_DISABLED' });
        return;
      }
      const options = await buildAuthenticationOptions(operatorWebauthnRp(), {
        userVerification: 'required',
      });
      await saveWebauthnChallenge(options.challenge, {
        purpose: 'passkey_login',
        realm: 'operator',
      });
      return options;
    },
  );

  const passkeyBody = z.object({ credential: authenticationCredential });

  app.post(
    '/auth/passkey/verify',
    {
      config: authRateLimit,
      schema: {
        tags: ['Users'],
        summary: 'Sign in with a passkey',
        description:
          'Verifies the navigator.credentials.get response against the challenge of POST /v1/auth/passkey/options, the CSMS origin, the relying party ID, the stored public key and the signature counter, with user verification required. The passkey counts as both factors, so required MFA is met and no MFA step follows. Then the checks of the password sign-in apply: an inactive account answers 403 ACCOUNT_DISABLED, a password that must be changed answers mustResetPassword, and an SSO account while SSO is enabled is refused.',
        operationId: 'verifyPasskeyLogin',
        security: [],
        body: zodSchema(passkeyBody),
        response: {
          200: zodSchema(loginResponse),
          400: errorWith('Not verified', [
            ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
            ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
          ]),
          401: errorWith('Invalid credentials', [ERROR_CODES.INVALID_CREDENTIALS]),
          403: errorWith('Forbidden', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.MFA_METHOD_DISABLED,
          ]),
          404: errorWith('Passkey not registered', [ERROR_CODES.PASSKEY_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const credential = (request.body as z.infer<typeof passkeyBody>)
        .credential as unknown as AuthenticationResponseJSON;
      if (!(await passkeyLoginAllowed())) {
        await reply
          .status(403)
          .send({ error: 'Passkey sign-in is switched off', code: 'MFA_METHOD_DISABLED' });
        return;
      }
      const challenge = responseChallenge(credential);
      const record = challenge != null ? await takeWebauthnChallenge(challenge) : null;
      if (challenge == null || !isPasskeyLoginChallenge(record, 'operator')) {
        await sendChallengeExpired(reply);
        return;
      }

      const stored = await findWebauthnCredential(credential.id);
      const [user] =
        stored?.userId != null
          ? await db.select().from(users).where(eq(users.id, stored.userId))
          : [];
      if (stored == null || user == null) {
        // No account to key the row on: it is recorded without one.
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: null,
          action: 'login_failed',
          method: 'passkey',
          reason: 'webauthn_unknown_credential',
        });
        await reply
          .status(404)
          .send({ error: 'This passkey is not registered', code: 'PASSKEY_NOT_FOUND' });
        return;
      }
      // A passkey sign-in names the account through the credential's user handle, which
      // must be present and match the stored one (WebAuthn L3, 7.2 step 6).
      const handle = credential.response.userHandle;
      if (
        handle == null ||
        handle !== stored.userHandle ||
        !(await verifyAccountAssertion(
          request,
          { userId: user.id },
          credential,
          challenge,
          stored,
          true,
        ))
      ) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'passkey',
          reason: 'webauthn_verification_failed',
        });
        await sendVerificationFailed(reply);
        return;
      }

      if (await passwordAuthBlocked(user)) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'passkey',
          reason: 'sso_account',
        });
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }
      if (!user.isActive) {
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: user.id,
          action: 'login_failed',
          method: 'passkey',
          reason: 'inactive',
        });
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }
      if (user.mustResetPassword) return { mustResetPassword: true };

      const token = await issueOperatorSession(app, request, reply, user);
      await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await recordAuthAudit(request, {
        kind: 'user',
        accountId: user.id,
        action: 'login_succeeded',
        method: 'passkey',
      });
      return loginReply(user, token);
    },
  );
}

async function writeMfaEnabledAudit(request: FastifyRequest, userId: string): Promise<void> {
  await writeAudit(
    { table: userAuditLog, idColumn: 'user_id' },
    {
      entityId: userId,
      entityIdSnapshot: userId,
      action: 'mfa_enabled',
      ...getAuditActor(request),
      after: { mfaMethod: 'passkey' },
    },
    db,
    request.log,
  );
}
