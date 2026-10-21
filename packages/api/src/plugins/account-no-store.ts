// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { routePath } from './encoded-path-guard.js';

/**
 * Route prefixes (after `/v1`) whose replies describe a signed-in account, a
 * sign-in step, or an account an admin views (operator users and drivers: contact
 * details, MFA state, API keys, sessions).
 */
const ACCOUNT_PREFIXES = [
  '/users/',
  '/drivers/',
  '/auth/',
  '/portal/auth/',
  '/portal/driver',
  '/api-keys',
];

/** Whether a matched route path holds account or sign-in data. */
export function isAccountRoute(path: string): boolean {
  const bare = path.startsWith('/v1/') ? path.slice(3) : path;
  return ACCOUNT_PREFIXES.some(
    (prefix) => bare === prefix.replace(/\/$/, '') || bare.startsWith(prefix),
  );
}

/**
 * Sends `Cache-Control: no-store` on the replies of account and sign-in routes
 * (MFA status, passkeys, recovery codes, API keys, tokens) and of the admin views
 * of users and drivers, so no browser, proxy or shared cache keeps one. A route
 * that sets its own header keeps it.
 */
export function registerAccountNoStore(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (!reply.hasHeader('cache-control') && isAccountRoute(routePath(request))) {
      void reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}
