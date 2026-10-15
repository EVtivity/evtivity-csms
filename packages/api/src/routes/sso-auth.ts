// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
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
import { setAuthCookies, isSecureRequest } from '../lib/auth-cookies.js';
import { createRefreshToken } from '../services/refresh-token.service.js';
import { config as apiConfig } from '../lib/config.js';
import { errorWith } from '../lib/response-schemas.js';
import { emailEquals } from '../lib/email-match.js';
import { recordAuthAudit } from '../lib/auth-audit.js';
import { beginOperatorMfa, type OperatorMfaPending } from '../lib/operator-mfa.js';
import { signOperatorAccessToken } from '../lib/operator-session.js';
import {
  RedisSamlRequestCache,
  buildSaml,
  ssoEmailDomainAllowed,
} from '../lib/saml-request-cache.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';

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
        response: { 400: errorWith('Sso disabled', [ERROR_CODES.SSO_DISABLED]) },
      },
    },
    async (request, reply) => {
      const config = await getSsoConfig();
      if (config == null) {
        await reply.status(400).send({ error: 'SSO is not configured', code: 'SSO_DISABLED' });
        return;
      }

      // The request id is stored so the callback accepts only a reply to it.
      const saml = buildSaml(
        config,
        `${getBaseUrl()}/v1/auth/sso/callback`,
        new RedisSamlRequestCache(),
      );

      const loginUrl = await saml.getAuthorizeUrlAsync('/', request.hostname, {});
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
      if (typeof samlResponse !== 'string' || samlResponse === '') {
        await reply.redirect('/login?error=sso_config_error');
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
          await reply.redirect(`/login#${ssoMfaFragment(mfaPending)}`);
          return;
        }

        // Issue JWT and set cookies
        const token = signOperatorAccessToken(app, existingUser);
        const refreshResult = await createRefreshToken({ userId: existingUser.id });
        setAuthCookies('csms', reply, token, refreshResult.rawToken, isSecureRequest(request));

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

      const token = signOperatorAccessToken(app, {
        id: newUserId,
        roleId: defaultRole.id,
        sessionVersion: newUser?.sessionVersion ?? 0,
      });
      const refreshResult = await createRefreshToken({ userId: newUserId });
      setAuthCookies('csms', reply, token, refreshResult.rawToken, isSecureRequest(request));
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
 * The URL fragment that hands an SSO login's MFA pending state to the CSMS
 * login page, which shows the MFA challenge (`sso-mfa.ts` in the CSMS).
 */
export function ssoMfaFragment(pending: OperatorMfaPending): string {
  const params = new URLSearchParams({
    ssoMfaToken: pending.mfaToken,
    ssoMfaMethod: pending.mfaMethod,
  });
  if (pending.challengeId != null) params.set('ssoMfaChallengeId', String(pending.challengeId));
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
