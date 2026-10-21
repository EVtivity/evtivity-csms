// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isMfaChallengeLimited, dispatchSystemNotification } from '@evtivity/lib';
import {
  client,
  db,
  driverAuditLog,
  drivers,
  getCompanyName,
  getMfaConfig,
  readMfaConfig,
  writeAudit,
} from '@evtivity/database';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import type { DriverJwtPayload } from '../../plugins/auth.js';
import { config as apiConfig } from '../../lib/config.js';
import { zodSchema } from '../../lib/zod-schema.js';
import { arrayResponse, errorWith, itemResponse } from '../../lib/response-schemas.js';
import { ERROR_CODES } from '../../lib/error-codes.generated.js';
import { getAuditActor } from '../../lib/audit-actor.js';
import { recordAuthAudit } from '../../lib/auth-audit.js';
import { isMobileClient, issueDriverSession, issueDriverTokens } from '../../lib/driver-session.js';
import { endDriverSessions } from '../../services/refresh-token.service.js';
import { driverSessionColumns } from '../../lib/driver-session-columns.js';
import {
  authenticateDriverOrMfaEnrollment,
  driverMfaEnrollmentAfterVerify,
  driverMfaPolicy,
  isDriverMfaEnrollmentRequest,
  isDriverMobileMfaUnsupported,
  mobileMfaUnsupportedAuditReason,
  sendMobileMfaUnsupported,
} from '../../lib/driver-mfa.js';
import {
  MFA_SETUP_METHODS,
  mfaPendingTokenCurrent,
  sendMfaTokenExpired,
} from '../../lib/mfa-enrollment.js';
import { passkeyGate } from '../../lib/mfa-factors.js';
import { createAccountMfaChallenge, sendMfaResendLimited } from '../../lib/sign-in-backoff.js';
import { mfaCodeDestination, mfaCodeRecipient } from '../../lib/mfa-contact.js';
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
} from '../../services/mfa-factor.service.js';
import {
  WebauthnVerificationError,
  buildAuthenticationOptions,
  buildRegistrationOptions,
  checkRegistration,
  driverWebauthnRp,
  newUserHandle,
  responseChallenge,
} from '../../lib/webauthn.js';
import { saveWebauthnChallenge, takeWebauthnChallenge } from '../../lib/webauthn-challenges.js';
import { isChallengeFor, isPasskeyLoginChallenge } from '../../lib/webauthn-challenge-records.js';
import {
  authenticationCredential,
  checkFactorProof,
  factorProof,
  factorProofKinds,
  sendFactorProofRefusal,
  verifyAccountAssertion,
} from '../../lib/mfa-factor-proof.js';
import {
  cleanCredentialName,
  creationOptions,
  credentialItem,
  credentialName,
  defaultCredentialName,
  factorProofBody,
  factorProofResponse,
  idParams,
  passkeyLoginAllowed,
  proofKindsField,
  registrationCredential,
  registrationResponse,
  requestOptions,
  sendChallengeExpired,
  sendVerificationFailed,
  serializeCredential,
} from '../../lib/webauthn-http.js';
import { portalDriverItem } from '../../lib/portal-driver-item.js';

// The driver side of routes/webauthn.ts: passkeys and security keys in the portal. The relying
// party is the portal (driverWebauthnRp), challenges and credentials are keyed by the driver,
// so an operator credential or challenge never verifies here and the reverse.

const authRateLimit = {
  rateLimit: { max: apiConfig.AUTH_RATE_LIMIT_MAX, timeWindow: apiConfig.AUTH_RATE_LIMIT_WINDOW },
};

const mobileSessionFields = {
  token: z.string().optional().describe('Access JWT, mobile clients only'),
  refreshToken: z.string().optional().describe('Opaque refresh token, mobile clients only'),
  expiresIn: z.number().int().optional().describe('Access token lifetime in seconds'),
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
      'With a session: fresh proof of the driver (its current factor, else its password). Not needed with the enrollmentToken',
    ),
});

const driverRegistrationResponse = registrationResponse
  .extend({
    success: z.boolean().optional().describe('With an enrollmentToken: MFA is on'),
    driver: portalDriverItem
      .optional()
      .describe('With an enrollmentToken: the driver now signed in (session cookies)'),
    ...mobileSessionFields,
  })
  .passthrough();

const driverSignInResponse = z
  .object({
    driver: portalDriverItem.describe('The driver now signed in (session cookies)'),
    ...mobileSessionFields,
  })
  .passthrough();

const driverSecondFactorResponse = z
  .object({
    driver: portalDriverItem
      .optional()
      .describe('The driver now signed in (session cookies); absent with mfaEnrollmentRequired'),
    mfaEnrollmentRequired: z
      .boolean()
      .optional()
      .describe(
        'Passkeys are switched off and were the only factor: no session is issued; set up another allowed method with enrollmentToken. Web clients only: a mobile client gets 403 MFA_ENROLLMENT_REQUIRED instead',
      ),
    enrollmentToken: z
      .string()
      .optional()
      .describe(
        'With mfaEnrollmentRequired: a 10-minute Bearer token valid only for POST /v1/portal/driver/mfa/setup, /confirm and the passkey registration routes',
      ),
    availableMethods: z
      .array(z.enum(MFA_SETUP_METHODS))
      .optional()
      .describe('With mfaEnrollmentRequired: the methods the driver can set up now'),
    webauthnAvailable: z
      .boolean()
      .optional()
      .describe('With mfaEnrollmentRequired: a passkey or security key can be the enrolled factor'),
    ...mobileSessionFields,
  })
  .passthrough();

const removeBody = z.object({
  proof: factorProof
    .optional()
    .describe(
      'Fresh proof of a factor the driver holds (the passkey itself included) or one of its recovery codes, the kinds GET /v1/portal/driver/mfa lists in lastFactorProofKinds; never the password alone',
    ),
});

const mfaTokenBody = z.object({
  mfaToken: z
    .string()
    .min(1)
    .describe('The mfaToken of the portal sign-in that answered mfaRequired'),
});

const secondFactorBody = mfaTokenBody.extend({ credential: authenticationCredential });

const passkeyBody = z.object({ credential: authenticationCredential });

type Driver = typeof drivers.$inferSelect;

/** The driver fields of a session reply, from a full driver row. */
function sessionDriver(driver: Driver): { id: string } & Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const key of Object.keys(driverSessionColumns)) {
    shaped[key] = driver[key as keyof Driver];
  }
  return { ...shaped, id: driver.id };
}

/** The MFA pending token of a portal sign-in, or the reply that refuses it (already sent). */
async function pendingDriver(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  mfaToken: string,
): Promise<Driver | null> {
  let payload: { driverId?: string; type?: string; mfaPending?: boolean };
  try {
    payload = app.jwt.verify(mfaToken);
  } catch (err) {
    request.log.debug({ err }, 'MFA token did not verify, refusing it');
    await reply
      .status(401)
      .send({ error: 'Invalid or expired MFA token', code: 'MFA_TOKEN_EXPIRED' });
    return null;
  }
  if (
    payload.mfaPending !== true ||
    payload.type !== 'driver' ||
    typeof payload.driverId !== 'string'
  ) {
    await reply.status(400).send({ error: 'Invalid MFA token', code: 'MFA_TOKEN_INVALID' });
    return null;
  }
  const [driver] = await db.select().from(drivers).where(eq(drivers.id, payload.driverId));
  if (driver == null) {
    await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
    return null;
  }
  if (!mfaPendingTokenCurrent(payload, driver.sessionVersion)) {
    await sendMfaTokenExpired(reply);
    return null;
  }
  if (!driver.isActive) {
    await recordAuthAudit(request, {
      kind: 'driver',
      accountId: driver.id,
      action: 'login_failed',
      method: 'webauthn',
      reason: 'inactive',
    });
    await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    return null;
  }
  // A passkey signature cannot be guessed, so the MFA lock of wrong codes does not
  // hold the passkey step: a guesser cannot lock the owner out of it.
  return driver;
}

async function refuseSecondFactor(
  request: FastifyRequest,
  reply: FastifyReply,
  driver: Driver,
  reason: string,
): Promise<void> {
  await recordAuthAudit(request, {
    kind: 'driver',
    accountId: driver.id,
    action: 'login_failed',
    method: 'webauthn',
    reason,
  });
  await sendVerificationFailed(reply);
}

async function sendPasskeysOff(reply: FastifyReply): Promise<void> {
  await reply.status(403).send({
    error: 'Passkeys and security keys are switched off',
    code: 'MFA_METHOD_DISABLED',
  });
}

async function sendLimitReached(reply: FastifyReply): Promise<void> {
  await reply.status(409).send({
    error: `At most ${String(MAX_WEBAUTHN_CREDENTIALS)} passkeys and security keys`,
    code: 'PASSKEY_LIMIT_REACHED',
  });
}

async function writeMfaEnabledAudit(request: FastifyRequest, driverId: string): Promise<void> {
  await writeAudit(
    { table: driverAuditLog, idColumn: 'driver_id' },
    {
      entityId: driverId,
      entityIdSnapshot: driverId,
      action: 'mfa_enabled',
      ...getAuditActor(request),
      after: { mfaMethod: 'passkey' },
    },
    db,
    request.log,
  );
}

export function portalWebauthnRoutes(app: FastifyInstance): void {
  // Registration: a signed-in driver, or the enrollment token of a portal sign-in that
  // requires MFA (the passkey is then the enrolled factor).

  app.post(
    '/portal/driver/webauthn/registration-options',
    {
      onRequest: [authenticateDriverOrMfaEnrollment(app)],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Driver'],
        summary: 'Start registering a passkey or security key',
        description:
          'Returns the options for navigator.credentials.create at the portal relying party: no attestation, a discoverable credential preferred, user verification preferred, and the credentials already registered excluded. The challenge is valid for 5 minutes and one registration. Takes a session, or the enrollmentToken of a portal sign-in that answered mfaEnrollmentRequired.',
        operationId: 'portalGetWebauthnRegistrationOptions',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(creationOptions),
          401: errorWith('Unauthorized', [
            ERROR_CODES.UNAUTHORIZED,
            ERROR_CODES.ACCOUNT_DEACTIVATED,
          ]),
          403: errorWith('Passkeys are switched off', [ERROR_CODES.MFA_METHOD_DISABLED]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
          409: errorWith('Too many passkeys', [ERROR_CODES.PASSKEY_LIMIT_REACHED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      if (!(await getMfaConfig()).webauthnEnabled) {
        await sendPasskeysOff(reply);
        return;
      }
      const [driver] = await db
        .select({
          email: drivers.email,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      if (driver == null) {
        await reply.status(404).send({ error: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
        return;
      }
      const existing = await webauthnCredentialsForCeremony({ driverId });
      if (existing.length >= MAX_WEBAUTHN_CREDENTIALS) {
        await sendLimitReached(reply);
        return;
      }
      const userHandle = (await accountUserHandle({ driverId })) ?? newUserHandle();
      const displayName = [driver.firstName, driver.lastName].filter((v) => v !== '').join(' ');
      const userName = driver.email ?? driverId;
      const options = await buildRegistrationOptions({
        rp: driverWebauthnRp(),
        rpName: await getCompanyName(),
        userName,
        userDisplayName: displayName !== '' ? displayName : userName,
        userHandle,
        exclude: existing.map((c) => ({ credentialId: c.credentialId, transports: c.transports })),
      });
      await saveWebauthnChallenge(options.challenge, {
        purpose: 'registration',
        driverId,
        userHandle,
      });
      return options;
    },
  );

  app.post(
    '/portal/driver/webauthn/registration',
    {
      onRequest: [authenticateDriverOrMfaEnrollment(app)],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Driver'],
        summary: 'Register a passkey or security key',
        description:
          'Verifies the navigator.credentials.create response against the challenge of the registration options, the portal origin and the relying party ID, and stores the public key (attestation none). With a session it needs a fresh proof of the driver in proof: its current factor when it has one (a TOTP code, an email or SMS code or a passkey, see POST /v1/portal/driver/mfa/factor-proof), else its password. A missing or wrong kind of proof answers 400 VALIDATION_ERROR with the accepted proofKinds. When it is the first factor of the driver, it turns MFA on and ten recovery codes come back, shown this once. With the enrollmentToken it also signs the driver in (session cookies and driver) and the token stops working.',
        operationId: 'portalRegisterWebauthnCredential',
        security: [{ bearerAuth: [] }],
        body: zodSchema(registrationBody),
        response: {
          200: itemResponse(driverRegistrationResponse),
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
          409: errorWith('Too many passkeys', [ERROR_CODES.PASSKEY_LIMIT_REACHED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const body = request.body as z.infer<typeof registrationBody>;
      const credential = body.credential as unknown as RegistrationResponseJSON;
      const enrolling = isDriverMfaEnrollmentRequest(request);

      if (!(await getMfaConfig()).webauthnEnabled) {
        await sendPasskeysOff(reply);
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
      // A stolen session cannot add a factor: it must prove the driver first.
      if (!enrolling) {
        const refused = await checkFactorProof(request, { driverId }, body.proof);
        if (refused != null) {
          await sendFactorProofRefusal(reply, refused);
          return;
        }
      }
      const challenge = responseChallenge(credential);
      const record = challenge != null ? await takeWebauthnChallenge(challenge) : null;
      if (challenge == null || !isChallengeFor(record, 'registration', { driverId })) {
        await sendChallengeExpired(reply);
        return;
      }

      let verified;
      try {
        verified = await checkRegistration(credential, challenge, driverWebauthnRp());
      } catch (err) {
        if (!(err instanceof WebauthnVerificationError)) throw err;
        request.log.info({ err: err.cause, driverId }, 'WebAuthn registration refused');
        await sendVerificationFailed(reply);
        return;
      }

      const ctx = { actor: getAuditActor(request), log: request.log };
      const registered = await registerWebauthnCredential(
        { driverId },
        { ...verified, userHandle: record.userHandle, name },
        ctx,
      );
      if (registered.status === 'limit_reached') {
        await sendLimitReached(reply);
        return;
      }
      if (registered.status === 'duplicate') {
        request.log.info({ driverId }, 'WebAuthn credential is already registered');
        await sendVerificationFailed(reply);
        return;
      }
      const { credential: stored, firstFactor } = registered;

      if (enrolling) {
        // The same compare-and-set as the MFA confirm: of two registrations with one
        // enrollment token, one signs in; the new version ends the token.
        const sv = (request.user as { sv?: unknown }).sv;
        const [bumped] = await db
          .update(drivers)
          .set({
            sessionVersion: sql`${drivers.sessionVersion} + 1`,
            mfaFailedCount: 0,
            mfaLockedUntil: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(drivers.id, driverId),
              eq(drivers.sessionVersion, typeof sv === 'number' ? sv : 0),
            ),
          )
          .returning({ id: drivers.id });
        if (bumped == null) {
          await reply.status(401).send({ error: 'Session ended', code: 'UNAUTHORIZED' });
          return;
        }
        // The token's sign-in ends every other session of the driver, refresh tokens included.
        await endDriverSessions(driverId);
        await writeMfaEnabledAudit(request, driverId);
        const recoveryCodes = await issueRecoveryCodes({ driverId }, 'generated', ctx);
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
          extra: { success: true, credential: serializeCredential(stored), recoveryCodes },
        });
        return;
      }

      if (!firstFactor) return { credential: serializeCredential(stored) };
      // A first factor turns MFA on and ends every other session of the driver, as the MFA
      // confirm does; this client gets new tokens.
      await writeMfaEnabledAudit(request, driverId);
      const recoveryCodes = await issueRecoveryCodes({ driverId }, 'generated', ctx);
      await endDriverSessions(driverId);
      const tokens = await issueDriverTokens(app, request, reply, driverId);
      return { credential: serializeCredential(stored), recoveryCodes, ...(tokens ?? {}) };
    },
  );

  app.get(
    '/portal/driver/webauthn',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'List my passkeys and security keys',
        operationId: 'portalListWebauthnCredentials',
        security: [{ bearerAuth: [] }],
        response: { 200: arrayResponse(credentialItem) },
      },
    },
    async (request) => {
      const { driverId } = request.user as DriverJwtPayload;
      return (await listWebauthnCredentials({ driverId })).map(serializeCredential);
    },
  );

  app.patch(
    '/portal/driver/webauthn/:id',
    {
      onRequest: [app.authenticateDriver],
      schema: {
        tags: ['Portal Driver'],
        summary: 'Rename a passkey or security key',
        operationId: 'portalRenameWebauthnCredential',
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
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = idParams.parse(request.params);
      const name = cleanCredentialName((request.body as { name: string }).name);
      if (name == null) {
        await reply.status(400).send({
          error: 'The name must have 1 to 100 visible characters',
          code: 'VALIDATION_ERROR',
        });
        return;
      }
      const row = await renameWebauthnCredential({ driverId }, id, name, {
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

  app.delete(
    '/portal/driver/webauthn/:id',
    {
      onRequest: [app.authenticateDriver],
      // A removal proof can be a code, so a stolen session cannot guess it here.
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Driver'],
        summary: 'Remove a passkey or security key',
        description:
          'Send { proof }. Every removal needs a fresh proof of the driver: a factor it holds (a TOTP code, an email or SMS code, or a passkey prepared by POST /v1/portal/driver/mfa/factor-proof) or one of its recovery codes, the kinds GET /v1/portal/driver/mfa lists in lastFactorProofKinds; never the password alone. Removes the credential and ends the other sessions of the driver (this browser gets a new one; a mobile client gets new tokens in the body). When it is the last MFA factor (no email, SMS or TOTP method and no other passkey), MFA turns off and the recovery codes go too. A missing or wrong kind of proof answers 400 VALIDATION_ERROR with the accepted proofKinds; a wrong proof counts toward the driver backoff. While required MFA covers drivers the removal answers 409 MFA_REQUIRED_BY_POLICY (503 MFA_POLICY_UNAVAILABLE when the MFA settings cannot be read).',
        operationId: 'portalDeleteWebauthnCredential',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(removeBody),
        response: {
          200: itemResponse(
            z
              .object({
                success: z.literal(true).describe('Removed'),
                ...mobileSessionFields,
              })
              .passthrough(),
          ),
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
          409: errorWith('Required MFA covers drivers', [ERROR_CODES.MFA_REQUIRED_BY_POLICY]),
          503: errorWith('MFA settings unavailable', [ERROR_CODES.MFA_POLICY_UNAVAILABLE]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const { id } = idParams.parse(request.params);
      const { proof } = request.body as z.infer<typeof removeBody>;
      const account = { driverId };

      // Every removal needs a fresh proof, so a stolen session cannot strip a factor.
      // Checked before the account row lock: a wrong proof counts toward the proof
      // backoff, an UPDATE of the row the lock holds.
      const proofRefusal = await checkFactorProof(request, account, proof, 'remove');
      if (proofRefusal != null) {
        await sendFactorProofRefusal(reply, proofRefusal);
        return;
      }

      const removed = await removeWebauthnCredential(
        account,
        id,
        {
          lastFactorCheck: async () => {
            const policy = await driverMfaPolicy();
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
        await reply.status(409).send({
          error: 'MFA is required for drivers: add another factor before removing this one',
          code: 'MFA_REQUIRED_BY_POLICY',
        });
        return;
      }
      // The removal ended every session of the driver; this browser gets a new one.
      const tokens = await issueDriverTokens(app, request, reply, driverId);
      return { success: true as const, ...(tokens ?? {}) };
    },
  );

  // Proof for POST /v1/portal/driver/mfa/recovery-codes: a passkey of the signed-in driver.

  app.post(
    '/portal/driver/mfa/recovery-codes/webauthn-options',
    {
      onRequest: [app.authenticateDriver],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Driver'],
        summary: 'Start the passkey proof for new recovery codes',
        description:
          'Returns the options for navigator.credentials.get with the credentials of the signed-in driver (user verification preferred). Send the response as credential to POST /v1/portal/driver/mfa/recovery-codes. The challenge is valid for 5 minutes and one response. Works while passkeys are switched off: the caller is already signed in.',
        operationId: 'portalGetRecoveryCodesWebauthnOptions',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(requestOptions),
          400: errorWith('Bad request', [ERROR_CODES.MFA_NOT_CONFIGURED]),
        },
      },
    },
    async (request, reply) => {
      const { driverId } = request.user as DriverJwtPayload;
      const credentials = await webauthnCredentialsForCeremony({ driverId });
      if (credentials.length === 0) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      const options = await buildAuthenticationOptions(driverWebauthnRp(), {
        userVerification: 'preferred',
        allow: credentials.map((c) => ({ credentialId: c.credentialId, transports: c.transports })),
      });
      await saveWebauthnChallenge(options.challenge, { purpose: 'recovery_regenerate', driverId });
      return options;
    },
  );

  // Preparing a proof for adding a factor: an email or SMS code, or a passkey challenge.

  app.post(
    '/portal/driver/mfa/factor-proof',
    {
      onRequest: [app.authenticateDriver],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal Driver'],
        summary: 'Prepare the proof for adding an MFA factor',
        description:
          'Adding a passkey with a session needs a fresh proof of the driver (proof on POST /v1/portal/driver/webauthn/registration; also POST /v1/portal/driver/mfa/confirm when the driver already has a factor). A TOTP code or the password needs no preparation. kind code sends a code to the email or SMS method of the driver and returns its challengeId (at most 5 codes in 15 minutes, 429 MFA_RESEND_LIMITED). kind passkey returns the options for navigator.credentials.get with the driver credentials; the challenge is valid for 5 minutes and one response. 400 MFA_NOT_CONFIGURED when the driver has no such factor.',
        operationId: 'portalPrepareMfaFactorProof',
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
      const { driverId } = request.user as DriverJwtPayload;
      const { kind } = request.body as z.infer<typeof factorProofBody>;
      const kinds = await factorProofKinds({ driverId });

      if (kind === 'passkey') {
        const credentials = kinds.includes('passkey')
          ? await webauthnCredentialsForCeremony({ driverId })
          : [];
        if (credentials.length === 0) {
          await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
          return;
        }
        const options = await buildAuthenticationOptions(driverWebauthnRp(), {
          userVerification: 'preferred',
          allow: credentials.map((c) => ({
            credentialId: c.credentialId,
            transports: c.transports,
          })),
        });
        await saveWebauthnChallenge(options.challenge, { purpose: 'factor_add', driverId });
        return { options };
      }

      const [driver] = await db
        .select({
          mfaMethod: drivers.mfaMethod,
          email: drivers.email,
          phone: drivers.phone,
          firstName: drivers.firstName,
          language: drivers.language,
        })
        .from(drivers)
        .where(eq(drivers.id, driverId));
      const method = driver?.mfaMethod;
      if (driver == null || !kinds.includes('code') || (method !== 'email' && method !== 'sms')) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      const challenge = await createAccountMfaChallenge({ driverId }, method, {
        purpose: 'proof',
        destination: mfaCodeDestination(method, driver),
        destinationProven: true,
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

  // Second factor: after the portal password step, with its mfaPending token.

  app.post(
    '/portal/auth/webauthn/options',
    {
      config: authRateLimit,
      schema: {
        tags: ['Portal Auth'],
        summary: 'Start the passkey or security key MFA step',
        description:
          'Takes the mfaToken of a portal sign-in that answered mfaRequired with passkey among its factors. Returns the options for navigator.credentials.get with the driver credentials (user verification preferred, so a security key without a PIN works). The challenge is valid for 5 minutes and one response.',
        operationId: 'portalGetWebauthnMfaOptions',
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
      const driver = await pendingDriver(app, request, reply, mfaToken);
      if (driver == null) return;
      const credentials = await webauthnCredentialsForCeremony({ driverId: driver.id });
      if (credentials.length === 0) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      const counts = await mfaFactorCounts({ driverId: driver.id });
      if (passkeyGate({ ...driver, ...counts }, await readMfaConfig()) === 'refused') {
        await sendPasskeysOff(reply);
        return;
      }
      const options = await buildAuthenticationOptions(driverWebauthnRp(), {
        userVerification: 'preferred',
        allow: credentials.map((c) => ({ credentialId: c.credentialId, transports: c.transports })),
      });
      await saveWebauthnChallenge(options.challenge, {
        purpose: 'second_factor',
        driverId: driver.id,
      });
      return options;
    },
  );

  app.post(
    '/portal/auth/webauthn/verify',
    {
      config: authRateLimit,
      schema: {
        tags: ['Portal Auth'],
        summary: 'Complete the MFA step with a passkey or security key',
        description:
          'Verifies the navigator.credentials.get response against the challenge of POST /v1/portal/auth/webauthn/options, the portal origin, the relying party ID, the stored public key and the signature counter, then issues the driver session. A response that does not verify counts toward the per-driver MFA backoff. When passkeys are switched off and were the only factor, no session is issued: a web client gets mfaEnrollmentRequired with an enrollmentToken, a mobile client 403 MFA_ENROLLMENT_REQUIRED.',
        operationId: 'portalVerifyWebauthnMfa',
        security: [],
        body: zodSchema(secondFactorBody),
        response: {
          200: itemResponse(driverSecondFactorResponse),
          400: errorWith('Bad request', [
            ERROR_CODES.MFA_NOT_CONFIGURED,
            ERROR_CODES.MFA_TOKEN_INVALID,
            ERROR_CODES.WEBAUTHN_CHALLENGE_EXPIRED,
            ERROR_CODES.WEBAUTHN_VERIFICATION_FAILED,
          ]),
          401: errorWith('Unauthorized', [ERROR_CODES.MFA_TOKEN_EXPIRED]),
          403: errorWith('Forbidden', [
            ERROR_CODES.ACCOUNT_DISABLED,
            ERROR_CODES.MFA_ENROLLMENT_REQUIRED,
            ERROR_CODES.MFA_METHOD_DISABLED,
          ]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof secondFactorBody>;
      const credential = body.credential as unknown as AuthenticationResponseJSON;
      const driver = await pendingDriver(app, request, reply, body.mfaToken);
      if (driver == null) return;

      const reading = await readMfaConfig();
      const counts = await mfaFactorCounts({ driverId: driver.id });
      if (counts.passkeyCount === 0) {
        await reply.status(400).send({ error: 'MFA not configured', code: 'MFA_NOT_CONFIGURED' });
        return;
      }
      const gate = passkeyGate({ ...driver, ...counts }, reading);
      if (gate === 'refused') {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'webauthn',
          reason: 'mfa_method_disabled',
        });
        await sendPasskeysOff(reply);
        return;
      }

      const challenge = responseChallenge(credential);
      const record = challenge != null ? await takeWebauthnChallenge(challenge) : null;
      const account = { driverId: driver.id };
      if (challenge == null || !isChallengeFor(record, 'second_factor', account)) {
        await sendChallengeExpired(reply);
        return;
      }
      const stored = await findWebauthnCredential(credential.id);
      if (stored?.driverId !== driver.id) {
        await refuseSecondFactor(request, reply, driver, 'webauthn_unknown_credential');
        return;
      }
      if (!(await verifyAccountAssertion(request, account, credential, challenge, stored, false))) {
        await refuseSecondFactor(request, reply, driver, 'webauthn_verification_failed');
        return;
      }
      // Passkeys switched off and the only factor: proven, now set up an allowed method.
      const enrollment =
        gate === 'enrollment_required'
          ? driverMfaEnrollmentAfterVerify(app, driver, reading.config, {
              mobile: isMobileClient(request),
            })
          : null;
      if (enrollment != null && isDriverMobileMfaUnsupported(enrollment)) {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'webauthn',
          reason: mobileMfaUnsupportedAuditReason(enrollment.mobileMfaUnsupported),
        });
        await sendMobileMfaUnsupported(
          reply,
          enrollment.mobileMfaUnsupported,
          apiConfig.PORTAL_URL,
        );
        return;
      }
      if (enrollment != null) return enrollment;

      await recordAuthAudit(request, {
        kind: 'driver',
        accountId: driver.id,
        action: 'login_succeeded',
        method: 'webauthn',
      });
      await issueDriverSession(app, request, reply, sessionDriver(driver));
      return;
    },
  );

  // Passkey sign-in: no password, the passkey with user verification is both factors.

  app.post(
    '/portal/auth/passkey/options',
    {
      config: authRateLimit,
      schema: {
        tags: ['Portal Auth'],
        summary: 'Start a passkey sign-in',
        description:
          'Only while Settings > Security > MFA allows passkey sign-in. Returns the options for navigator.credentials.get at the portal relying party without a credential list (the browser offers the discoverable passkeys of the relying party) and with user verification required. The challenge is valid for 5 minutes and one response.',
        operationId: 'portalGetPasskeyLoginOptions',
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
      const options = await buildAuthenticationOptions(driverWebauthnRp(), {
        userVerification: 'required',
      });
      await saveWebauthnChallenge(options.challenge, { purpose: 'passkey_login', realm: 'driver' });
      return options;
    },
  );

  app.post(
    '/portal/auth/passkey/verify',
    {
      config: authRateLimit,
      schema: {
        tags: ['Portal Auth'],
        summary: 'Sign in with a passkey',
        description:
          'Verifies the navigator.credentials.get response against the challenge of POST /v1/portal/auth/passkey/options, the portal origin, the relying party ID, the stored public key and the signature counter, with user verification required. The passkey counts as both factors, so required MFA is met and no MFA step follows. An inactive driver answers 403 ACCOUNT_DISABLED; a credential of an operator, or one that is not registered, answers 404 PASSKEY_NOT_FOUND.',
        operationId: 'portalVerifyPasskeyLogin',
        security: [],
        body: zodSchema(passkeyBody),
        response: {
          200: itemResponse(driverSignInResponse),
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
      if (challenge == null || !isPasskeyLoginChallenge(record, 'driver')) {
        await sendChallengeExpired(reply);
        return;
      }

      const stored = await findWebauthnCredential(credential.id);
      const [driver] =
        stored?.driverId != null
          ? await db.select().from(drivers).where(eq(drivers.id, stored.driverId))
          : [];
      if (stored == null || driver == null) {
        // No driver to key the row on (unknown, or an operator credential): recorded without one.
        await recordAuthAudit(request, {
          kind: 'driver',
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
      // A passkey sign-in names the driver through the credential's user handle, which
      // must be present and match the stored one (WebAuthn L3, 7.2 step 6).
      const handle = credential.response.userHandle;
      const account = { driverId: driver.id };
      if (
        handle == null ||
        handle !== stored.userHandle ||
        !(await verifyAccountAssertion(request, account, credential, challenge, stored, true))
      ) {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'passkey',
          reason: 'webauthn_verification_failed',
        });
        await sendVerificationFailed(reply);
        return;
      }
      if (!driver.isActive) {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'passkey',
          reason: 'inactive',
        });
        await reply.status(403).send({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
        return;
      }
      // Portal access is a password the driver set (an operator-created driver accepts an
      // invite first), as at the password sign-in.
      if (driver.passwordHash == null) {
        await recordAuthAudit(request, {
          kind: 'driver',
          accountId: driver.id,
          action: 'login_failed',
          method: 'passkey',
          reason: 'no_portal_access',
        });
        await reply.status(401).send({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
        return;
      }

      await recordAuthAudit(request, {
        kind: 'driver',
        accountId: driver.id,
        action: 'login_succeeded',
        method: 'passkey',
      });
      await issueDriverSession(app, request, reply, sessionDriver(driver));
      return;
    },
  );
}
