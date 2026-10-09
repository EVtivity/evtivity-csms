// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

const ACCESS_COOKIE_MAX_AGE = 60 * 60; // 1 hour in seconds
const CSMS_REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days
const PORTAL_REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

interface RealmConfig {
  tokenCookie: string;
  refreshCookie: string;
  csrfCookie: string;
  tokenPath: string;
  refreshMaxAge: number;
}

const REALM_CONFIGS = {
  csms: {
    tokenCookie: 'csms_token',
    refreshCookie: 'csms_refresh',
    csrfCookie: 'csms_csrf',
    tokenPath: '/',
    refreshMaxAge: CSMS_REFRESH_COOKIE_MAX_AGE,
  },
  portal: {
    tokenCookie: 'portal_token',
    refreshCookie: 'portal_refresh',
    csrfCookie: 'portal_csrf',
    tokenPath: '/v1/portal',
    refreshMaxAge: PORTAL_REFRESH_COOKIE_MAX_AGE,
  },
} as const satisfies Record<string, RealmConfig>;

export type AuthRealm = keyof typeof REALM_CONFIGS;

export function isSecureRequest(request: FastifyRequest): boolean {
  const proto = request.headers['x-forwarded-proto'];
  if (typeof proto === 'string') {
    return proto.split(',')[0]?.trim() === 'https';
  }
  return request.protocol === 'https';
}

export function setAuthCookies(
  realm: AuthRealm,
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string,
  secure: boolean,
): void {
  const cfg = REALM_CONFIGS[realm];
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const domainOpts = config.COOKIE_DOMAIN != null ? { domain: config.COOKIE_DOMAIN } : {};

  void reply.setCookie(cfg.tokenCookie, accessToken, {
    httpOnly: true,
    secure,
    signed: true,
    sameSite: 'lax',
    path: cfg.tokenPath,
    maxAge: ACCESS_COOKIE_MAX_AGE,
    ...domainOpts,
  });

  void reply.setCookie(cfg.refreshCookie, refreshToken, {
    httpOnly: true,
    secure,
    signed: true,
    sameSite: 'lax',
    path: '/',
    maxAge: cfg.refreshMaxAge,
    ...domainOpts,
  });

  void reply.setCookie(cfg.csrfCookie, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    ...domainOpts,
  });
}

/**
 * Result of reading a cookie set with `signed: true`. `absent`: the request
 * carries no such cookie. `invalid`: the cookie is present but its signature
 * does not verify (tampered, or signed with another secret). `valid`: the
 * unsigned value.
 */
export type SignedCookieRead =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'valid'; value: string };

/**
 * Reads a signed cookie. `request.cookies[name]` holds "<value>.<signature>",
 * so every read of a signed cookie must go through `request.unsignCookie()`.
 */
export function readSignedCookie(request: FastifyRequest, name: string): SignedCookieRead {
  const raw = request.cookies[name];
  if (raw == null || raw === '') return { status: 'absent' };
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === '') return { status: 'invalid' };
  return { status: 'valid', value: unsigned.value };
}

/** Reads the realm's signed refresh cookie (`csms_refresh` or `portal_refresh`). */
export function readRefreshCookie(realm: AuthRealm, request: FastifyRequest): SignedCookieRead {
  return readSignedCookie(request, REALM_CONFIGS[realm].refreshCookie);
}

export function clearAuthCookies(realm: AuthRealm, reply: FastifyReply, secure: boolean): void {
  const cfg = REALM_CONFIGS[realm];
  const domainOpts = config.COOKIE_DOMAIN != null ? { domain: config.COOKIE_DOMAIN } : {};

  void reply.clearCookie(cfg.tokenCookie, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: cfg.tokenPath,
    ...domainOpts,
  });

  void reply.clearCookie(cfg.refreshCookie, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    ...domainOpts,
  });

  void reply.clearCookie(cfg.csrfCookie, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    ...domainOpts,
  });
}
