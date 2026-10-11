// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/** Constant-time comparison of the CSRF cookie and the `x-csrf-token` header. */
export function csrfTokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Portal routes a browser calls before it holds a session (no CSRF cookie yet). */
const PORTAL_CSRF_SKIP_PATHS = new Set([
  '/v1/portal/auth/login',
  '/v1/portal/auth/register',
  '/v1/portal/auth/refresh',
  '/v1/portal/auth/verify-email',
  '/v1/portal/auth/forgot-password',
  '/v1/portal/auth/reset-password',
  '/v1/portal/auth/activate',
  '/v1/portal/payout-onboarding/link',
  '/v1/portal/payout-onboarding/status',
  '/v1/portal/auth/mfa/verify',
  '/v1/portal/auth/mfa/resend',
  '/v1/portal/auth/attest/challenge',
  '/v1/portal/auth/attest/register',
]);

export const CSRF_SKIP_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF validation for portal mutating requests (double-submit cookie
 * `portal_csrf` and header `x-csrf-token`). It does not depend on CORS: an
 * origin the CORS list does not name gets no CORS headers, and a cookie
 * request from it still needs the token, which another origin cannot read.
 * Needs `@fastify/cookie` registered first.
 */
export function registerPortalCsrf(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/portal/')) return;
    if (CSRF_SKIP_METHODS.has(request.method)) return;
    if (PORTAL_CSRF_SKIP_PATHS.has(url)) return;
    if (url.startsWith('/v1/portal/guest/')) return;

    // Bearer-authenticated, cookie-less clients (native mobile app) are not
    // subject to CSRF: CSRF defends ambient cookie sessions, and a Bearer token
    // is never auto-attached by a browser to a cross-site request. Requiring no
    // portal_token cookie keeps CSRF in force for any cookie session.
    const authz = request.headers.authorization;
    if (
      typeof authz === 'string' &&
      authz.startsWith('Bearer ') &&
      request.cookies['portal_token'] == null
    ) {
      return;
    }

    const cookieToken = request.cookies['portal_csrf'];
    const headerToken = request.headers['x-csrf-token'];
    if (
      cookieToken == null ||
      headerToken == null ||
      typeof headerToken !== 'string' ||
      cookieToken === '' ||
      !csrfTokensMatch(cookieToken, headerToken)
    ) {
      await reply.status(403).send({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
    }
  });
}
