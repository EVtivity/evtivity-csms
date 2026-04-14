// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SAML } from '@node-saml/node-saml';
import { eq, ilike } from 'drizzle-orm';
import { db, getSsoConfig, users, roles } from '@evtivity/database';
import { generateId } from '@evtivity/lib';
import { setAuthCookies } from '../lib/csms-cookies.js';
import { createRefreshToken } from '../services/refresh-token.service.js';
import { config as apiConfig } from '../lib/config.js';

function isSecureRequest(request: FastifyRequest): boolean {
  const proto = request.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0]?.trim() === 'https';
  }
  return request.protocol === 'https';
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
      },
    },
    async (request, reply) => {
      const config = await getSsoConfig();
      if (config == null) {
        await reply.status(400).send({ error: 'SSO is not configured', code: 'SSO_DISABLED' });
        return;
      }

      const saml = new SAML({
        entryPoint: config.entryPoint,
        issuer: config.issuer,
        idpCert: config.cert,
        callbackUrl: `${getBaseUrl()}/v1/auth/sso/callback`,
        wantAuthnResponseSigned: true,
      });

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

      const saml = new SAML({
        entryPoint: config.entryPoint,
        issuer: config.issuer,
        idpCert: config.cert,
        callbackUrl: `${getBaseUrl()}/v1/auth/sso/callback`,
        wantAuthnResponseSigned: true,
      });

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
        profile = result.profile as unknown as Record<string, unknown>;
      } catch {
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
        })
        .from(users)
        .where(ilike(users.email, email))
        .limit(1);

      if (existingUser != null) {
        if (!existingUser.isActive) {
          await reply.redirect('/login?error=sso_account_disabled');
          return;
        }

        // Issue JWT and set cookies
        const token = app.jwt.sign(
          { userId: existingUser.id, roleId: existingUser.roleId },
          { expiresIn: '1h' },
        );
        const refreshResult = await createRefreshToken({ userId: existingUser.id });
        setAuthCookies(reply, token, refreshResult.rawToken, isSecureRequest(request));

        await db
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, existingUser.id));

        await reply.redirect('/');
        return;
      }

      // User not found
      if (!config.autoProvision) {
        await reply.redirect('/login?error=sso_user_not_found');
        return;
      }

      // Validate email domain when auto-provisioning
      if (config.allowedDomains.length > 0) {
        const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
        if (!config.allowedDomains.includes(emailDomain)) {
          await reply.redirect('/login?error=sso_domain_not_allowed');
          return;
        }
      }

      // Auto-provision: validate the default role exists
      if (config.defaultRoleId === '') {
        await reply.redirect('/login?error=sso_config_error');
        return;
      }

      const [defaultRole] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.id, config.defaultRoleId))
        .limit(1);

      if (defaultRole == null) {
        await reply.redirect('/login?error=sso_config_error');
        return;
      }

      const newUserId = generateId('user');
      await db.insert(users).values({
        id: newUserId,
        email,
        firstName,
        lastName,
        passwordHash: '', // SSO users have no password
        roleId: defaultRole.id,
        isActive: true,
        hasAllSiteAccess: false,
        lastLoginAt: new Date(),
      });

      const token = app.jwt.sign(
        { userId: newUserId, roleId: defaultRole.id },
        { expiresIn: '1h' },
      );
      const refreshResult = await createRefreshToken({ userId: newUserId });
      setAuthCookies(reply, token, refreshResult.rawToken, isSecureRequest(request));

      await reply.redirect('/');
    },
  );
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
