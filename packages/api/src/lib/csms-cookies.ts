// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { config } from './config.js';

export const CSMS_ACCESS_COOKIE_MAX_AGE = 60 * 60; // 1 hour in seconds
export const CSMS_REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

const baseCookieOpts = config.COOKIE_DOMAIN != null ? { domain: config.COOKIE_DOMAIN } : {};

export function setAuthCookies(
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string,
  secure: boolean,
): void {
  const csrfToken = crypto.randomBytes(32).toString('hex');

  void reply.setCookie('csms_token', accessToken, {
    httpOnly: true,
    secure,
    signed: true,
    sameSite: 'lax',
    path: '/',
    maxAge: CSMS_ACCESS_COOKIE_MAX_AGE,
    ...baseCookieOpts,
  });

  void reply.setCookie('csms_refresh', refreshToken, {
    httpOnly: true,
    secure,
    signed: true,
    sameSite: 'lax',
    path: '/',
    maxAge: CSMS_REFRESH_COOKIE_MAX_AGE,
    ...baseCookieOpts,
  });

  void reply.setCookie('csms_csrf', csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: CSMS_ACCESS_COOKIE_MAX_AGE,
    ...baseCookieOpts,
  });
}

export function clearAuthCookies(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie('csms_token', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    ...baseCookieOpts,
  });

  void reply.clearCookie('csms_refresh', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    ...baseCookieOpts,
  });

  void reply.clearCookie('csms_csrf', {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
    ...baseCookieOpts,
  });
}
