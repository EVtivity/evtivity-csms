// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  db,
  getSsoConfig,
  users,
  roles,
  userPermissions,
  writeAudit,
  userAuditLog,
} from '@evtivity/database';
import { generateId, permissionCatalog } from '@evtivity/lib';
import { config as apiConfig } from '../lib/config.js';
import { errorWith } from '../lib/response-schemas.js';
import { emailEquals } from '../lib/email-match.js';
import { recordAuthAudit } from '../lib/auth-audit.js';
import { beginOperatorMfa, type OperatorMfaPending } from '../lib/operator-mfa.js';
import {
  isMfaPolicyUnavailable,
  isMfaSetupUnavailable,
  type OperatorMfaEnrollment,
  type MfaPolicyUnavailable,
  type MfaSetupUnavailable,
} from '../lib/mfa-enrollment.js';
import { issueOperatorSession } from '../lib/operator-session.js';
import { isSecureRequest } from '../lib/auth-cookies.js';
import {
  RedisSamlRequestCache,
  SAML_REQUEST_TTL_MS,
  buildSaml,
  samlBindingHash,
  ssoEmailDomainAllowed,
} from '../lib/saml-request-cache.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { zodSchema } from '../lib/zod-schema.js';

const ssoLoginQuery = z.object({
  state: z
    .string()
    .max(128)
    .optional()
    .describe(
      'A random value (16 to 64 letters, digits, - or _) the CSMS keeps for this browser tab; it comes back in the URL fragment of an SSO sign-in that needs MFA, and the login page ignores a fragment without it',
    ),
});

/**
 * The value the CSMS keeps in sessionStorage before it starts SSO and sends as
 * `state`: the IdP returns it as RelayState, and the callback puts it in the
 * fragment it hands the login page, which ignores a fragment without its own
 * value (a fragment planted by a link of someone else's sign-in).
 */
export const SSO_STATE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The state of a login request or a callback body, when it has the expected form. */
export function ssoState(value: unknown): string | null {
  return typeof value === 'string' && SSO_STATE_PATTERN.test(value) ? value : null;
}

/**
 * The cookie that binds an SSO sign-in to the browser that started it: the login
 * sets a random value, stores its hash with the SAML request id, and the
 * callback issues nothing unless the reply's request id has this browser's
 * value. A SAML reply of someone else's sign-in posted from another page
 * (login CSRF) finds no matching cookie.
 */
export const SSO_BINDING_COOKIE = 'csms_sso_binding';
/**
 * The same cookie bound to the API host: a sibling subdomain cannot set or
 * overwrite a `__Host-` cookie. Browsers accept the prefix only with Secure,
 * Path=/ and no Domain, so it is used over HTTPS without COOKIE_DOMAIN.
 */
export const SSO_BINDING_HOST_COOKIE = '__Host-csms_sso_binding';
const SSO_BINDING_PATH = '/v1/auth/sso';

interface SsoBindingCookie {
  name: string;
  options: {
    httpOnly: true;
    secure: boolean;
    path: string;
    sameSite: 'none' | false;
    domain?: string;
  };
}

/**
 * The IdP posts the reply from its own site, so the cookie must travel on a
 * cross-site POST: SameSite=None, which browsers accept only with Secure. Over
 * plain HTTP (local development) the cookie has no SameSite attribute: Firefox
 * and Safari send it, and Chrome sends it on a top-level POST within two minutes
 * of setting it. An IdP on the same site (a local test IdP) works either way.
 * With COOKIE_DOMAIN the cookie is shared with the subdomains of that domain.
 */
export function ssoBindingCookie(secure: boolean): SsoBindingCookie {
  const domain = apiConfig.COOKIE_DOMAIN;
  if (secure && domain == null) {
    return {
      name: SSO_BINDING_HOST_COOKIE,
      options: { httpOnly: true, secure: true, path: '/', sameSite: 'none' },
    };
  }
  return {
    name: SSO_BINDING_COOKIE,
    options: {
      httpOnly: true,
      secure,
      path: SSO_BINDING_PATH,
      sameSite: secure ? 'none' : false,
      ...(domain != null ? { domain } : {}),
    },
  };
}

function getBaseUrl(): string {
  // Use the configured CSMS URL instead of trusting X-Forwarded-Host headers
  return apiConfig.CSMS_URL.replace(/\/+$/, '');
}

export function ssoAuthRoutes(app: FastifyInstance): void {
  app.get(
    '/auth/sso/login',
    {
      schema: {
        tags: ['Settings'],
        summary: 'Initiate SAML SSO login',
        operationId: 'ssoLogin',
        security: [],
        querystring: zodSchema(ssoLoginQuery),
        response: { 400: errorWith('Sso disabled', [ERROR_CODES.SSO_DISABLED]) },
      },
    },
    async (request, reply) => {
      const config = await getSsoConfig();
      if (config == null) {
        await reply.status(400).send({ error: 'SSO is not configured', code: 'SSO_DISABLED' });
        return;
      }

      // The request id is stored so the callback accepts only a reply to it, with
      // the hash of this browser's binding cookie.
      const binding = crypto.randomBytes(32).toString('base64url');
      const saml = buildSaml(
        config,
        `${getBaseUrl()}/v1/auth/sso/callback`,
        new RedisSamlRequestCache(undefined, samlBindingHash(binding)),
      );

      // The IdP returns RelayState unchanged; '/' when the CSMS sent no state.
      const state = ssoState((request.query as z.infer<typeof ssoLoginQuery>).state);
      const loginUrl = await saml.getAuthorizeUrlAsync(state ?? '/', request.hostname, {});
      const bindingCookie = ssoBindingCookie(isSecureRequest(request));
      void reply.setCookie(bindingCookie.name, binding, {
        ...bindingCookie.options,
        maxAge: SAML_REQUEST_TTL_MS / 1000,
      });
      await reply.redirect(loginUrl);
    },
  );

  app.post(
    '/auth/sso/callback',
    {
      schema: {
        tags: ['Settings'],
        summary: 'SAML SSO assertion callback',
        operationId: 'ssoCallback',
        security: [],
      },
      config: { rawBody: false },
    },
    async (request, reply) => {
      const config = await getSsoConfig();
      if (config == null) {
        await reply.redirect('/login?error=sso_config_error');
        return;
      }

      const requestCache = new RedisSamlRequestCache();
      const saml = buildSaml(config, `${getBaseUrl()}/v1/auth/sso/callback`, requestCache);

      const body = request.body as Record<string, string>;
      const samlResponse = body['SAMLResponse'];
      const relayState = ssoState(body['RelayState']);
      if (typeof samlResponse !== 'string' || samlResponse === '') {
        await reply.redirect('/login?error=sso_config_error');
        return;
      }

      // The binding cookie is used once, whatever the outcome.
      const bindingCookie = ssoBindingCookie(isSecureRequest(request));
      const bindingValue = request.cookies[bindingCookie.name];
      const binding = bindingValue != null && bindingValue !== '' ? bindingValue : null;
      void reply.clearCookie(bindingCookie.name, bindingCookie.options);
      if (binding == null) {
        request.log.warn('SSO reply without the binding cookie of this browser, refusing it');
        await reply.redirect('/login?error=sso_session_mismatch');
        return;
      }

      let profile: Record<string, unknown>;
      try {
        const result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
        if (result.profile == null) {
          await reply.redirect('/login?error=sso_no_email');
          return;
        }
        // Each reply signs in once: a second post of the same reply finds
        // its request id already consumed.
        if (!(await requestCache.consumeRead())) {
          request.log.warn('SAML reply was already used, redirecting to login');
          await reply.redirect('/login?error=sso_config_error');
          return;
        }
        // Login CSRF: the reply must answer a sign-in this browser started.
        if (!(await requestCache.bindingMatches(binding))) {
          request.log.warn('SAML reply answers a sign-in another browser started, refusing it');
          await reply.redirect('/login?error=sso_session_mismatch');
          return;
        }
        profile = result.profile;
      } catch (err) {
        request.log.warn({ err }, 'SAML response did not validate, redirecting to login');
        await reply.redirect('/login?error=sso_config_error');
        return;
      }

      // Extract attributes using mapping
      const mapping = config.attributeMapping;
      const emailKey = mapping['email'] ?? 'email';
      const firstNameKey = mapping['firstName'] ?? 'firstName';
      const lastNameKey = mapping['lastName'] ?? 'lastName';

      const email = extractAttribute(profile, emailKey);
      const firstName = extractAttribute(profile, firstNameKey) ?? '';
      const lastName = extractAttribute(profile, lastNameKey) ?? '';

      if (email == null || email === '') {
        await reply.redirect('/login?error=sso_no_email');
        return;
      }

      // Look up user by email (case-insensitive)
      const [existingUser] = await db
        .select({
          id: users.id,
          roleId: users.roleId,
          isActive: users.isActive,
          email: users.email,
          phone: users.phone,
          firstName: users.firstName,
          language: users.language,
          mfaEnabled: users.mfaEnabled,
          mfaMethod: users.mfaMethod,
          sessionVersion: users.sessionVersion,
        })
        .from(users)
        .where(emailEquals(users.email, email))
        .limit(1);

      if (existingUser != null) {
        if (!existingUser.isActive) {
          await recordAuthAudit(request, {
            kind: 'user',
            accountId: existingUser.id,
            action: 'login_failed',
            method: 'sso',
            reason: 'inactive',
          });
          await reply.redirect('/login?error=sso_account_disabled');
          return;
        }

        // The allowed domains bind every SSO sign-in, not only new accounts.
        if (!ssoEmailDomainAllowed(email, config.allowedDomains)) {
          await recordAuthAudit(request, {
            kind: 'user',
            accountId: existingUser.id,
            action: 'login_failed',
            method: 'sso',
            reason: 'domain_not_allowed',
          });
          await reply.redirect('/login?error=sso_domain_not_allowed');
          return;
        }

        // The IdP assertion replaces the password, not the second factor: a
        // user with MFA completes the same challenge as a password login
        // before a session is issued. The pending state travels in the URL
        // fragment, which the browser never sends to a server.
        const mfaPending = await beginOperatorMfa(app, existingUser);
        if (mfaPending != null) {
          await redirectToMfa(request, reply, existingUser.id, mfaPending, relayState);
          return;
        }

        // Issue JWT and set cookies. The SSO sign-in time proves the account
        // for a security change (the `sso` proof) for the next 10 minutes.
        await issueOperatorSession(app, request, reply, {
          ...existingUser,
          ssoAuthAt: Math.floor(Date.now() / 1000),
        });

        await db
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, existingUser.id));
        await recordAuthAudit(request, {
          kind: 'user',
          accountId: existingUser.id,
          action: 'login_succeeded',
          method: 'sso',
        });

        await reply.redirect('/');
        return;
      }

      // User not found
      if (!config.autoProvision) {
        await reply.redirect('/login?error=sso_user_not_found');
        return;
      }

      if (!ssoEmailDomainAllowed(email, config.allowedDomains)) {
        await reply.redirect('/login?error=sso_domain_not_allowed');
        return;
      }

      // Auto-provision: validate the default role exists
      if (config.defaultRoleId === '') {
        await reply.redirect('/login?error=sso_config_error');
        return;
      }

      const [defaultRole] = await db
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.id, config.defaultRoleId))
        .limit(1);

      if (defaultRole == null) {
        await reply.redirect('/login?error=sso_config_error');
        return;
      }

      // The account and its role's default permissions are written together:
      // an account without permissions could sign in but see nothing.
      const newUserId = generateId('user');
      const roleDefaults = permissionCatalog.defaultsFor(defaultRole.name);
      const newUser = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            id: newUserId,
            email,
            firstName,
            lastName,
            passwordHash: '', // SSO users have no password
            authSource: 'sso',
            roleId: defaultRole.id,
            isActive: true,
            hasAllSiteAccess: false,
            lastLoginAt: new Date(),
          })
          .returning();
        if (roleDefaults.length > 0) {
          await tx
            .insert(userPermissions)
            .values(roleDefaults.map((permission) => ({ userId: newUserId, permission })))
            .onConflictDoNothing();
        }
        return row;
      });

      if (newUser != null) {
        await writeAudit(
          { table: userAuditLog, idColumn: 'user_id' },
          {
            entityId: newUser.id,
            entityIdSnapshot: newUser.id,
            action: 'created',
            actor: 'system',
            actorLabel: `sso:${config.issuer}`.slice(0, 100),
            after: { ...newUser, permissions: roleDefaults },
            notes: 'auto-provisioned via SSO',
          },
          db,
          request.log,
        );
      }

      // A new account has no MFA: required MFA sends it to set up a method first.
      const newUserMfa = await beginOperatorMfa(app, {
        id: newUserId,
        roleId: defaultRole.id,
        email,
        phone: null,
        firstName,
        language: newUser?.language ?? 'en',
        mfaEnabled: false,
        mfaMethod: null,
        sessionVersion: newUser?.sessionVersion ?? 0,
      });
      if (newUserMfa != null) {
        await redirectToMfa(request, reply, newUserId, newUserMfa, relayState);
        return;
      }

      await issueOperatorSession(app, request, reply, {
        id: newUserId,
        roleId: defaultRole.id,
        sessionVersion: newUser?.sessionVersion ?? 0,
        ssoAuthAt: Math.floor(Date.now() / 1000),
      });
      await recordAuthAudit(request, {
        kind: 'user',
        accountId: newUserId,
        action: 'login_succeeded',
        method: 'sso',
      });

      await reply.redirect('/');
    },
  );
}

/**
 * Sends an SSO login that needs MFA to the login page: the MFA challenge or
 * the MFA setup in the URL fragment, or an error when required MFA has no
 * method to set up or the MFA settings could not be read. No session is issued.
 */
async function redirectToMfa(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  pending: OperatorMfaPending | OperatorMfaEnrollment | MfaSetupUnavailable | MfaPolicyUnavailable,
  state: string | null,
): Promise<void> {
  if (isMfaPolicyUnavailable(pending)) {
    // requiredMfaEnrollment logged the settings read failure at error.
    await recordAuthAudit(request, {
      kind: 'user',
      accountId: userId,
      action: 'login_failed',
      method: 'sso',
      reason: 'mfa_policy_unavailable',
    });
    await reply.redirect('/login?error=sso_mfa_policy_unavailable');
    return;
  }
  if (isMfaSetupUnavailable(pending)) {
    await recordAuthAudit(request, {
      kind: 'user',
      accountId: userId,
      action: 'login_failed',
      method: 'sso',
      reason: 'mfa_setup_unavailable',
    });
    await reply.redirect('/login?error=sso_mfa_setup_unavailable');
    return;
  }
  await reply.redirect(`/login#${ssoMfaFragment(pending, state)}`);
}

/**
 * The URL fragment that hands an SSO login's MFA pending state to the CSMS
 * login page, which shows the MFA challenge (`sso-mfa.ts` in the CSMS), or
 * the enrollment token of required MFA, which opens the MFA setup page.
 */
export function ssoMfaFragment(
  pending: OperatorMfaPending | OperatorMfaEnrollment,
  state: string | null = null,
): string {
  if ('mfaEnrollmentRequired' in pending) {
    // Required MFA: the login page sends the user to set up MFA with this token.
    const enrollment = new URLSearchParams({
      ssoMfaEnrollmentToken: pending.enrollmentToken,
      ssoMfaEnrollmentMethods: pending.availableMethods.join(','),
    });
    if (state != null) enrollment.set('ssoState', state);
    return enrollment.toString();
  }
  const params = new URLSearchParams({
    ssoMfaToken: pending.mfaToken,
    ssoMfaMethod: pending.mfaMethod,
  });
  if (pending.challengeId != null) params.set('ssoMfaChallengeId', String(pending.challengeId));
  params.set('ssoMfaFactors', pending.factors.join(','));
  if (pending.mfaMethodDisabled === true) params.set('ssoMfaMethodDisabled', '1');
  if (state != null) params.set('ssoState', state);
  return params.toString();
}

function extractAttribute(profile: Record<string, unknown>, key: string): string | null {
  const value = profile[key];
  if (typeof value === 'string') return value;
  // Some IdPs nest attributes under a different path
  // node-saml may expose them at the top level or under profile attributes
  if (value == null) {
    // Try common SAML attribute name patterns
    const altKeys = [
      `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/${key}`,
      `http://schemas.xmlsoap.org/claims/${key}`,
      key.toLowerCase(),
    ];
    for (const alt of altKeys) {
      const altValue = profile[alt];
      if (typeof altValue === 'string') return altValue;
    }
  }
  return null;
}
