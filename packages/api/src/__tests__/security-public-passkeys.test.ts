// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({ portalUrl: 'https://portal.example.com' }));

vi.mock('../lib/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/config.js')>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, key) =>
        key === 'PORTAL_URL' ? state.portalUrl : (target as Record<PropertyKey, unknown>)[key],
    }),
  };
});

vi.mock('@evtivity/database', () => ({
  getRecaptchaConfig: vi.fn(async () => null),
  getMfaConfig: vi.fn(async () => ({
    emailEnabled: true,
    totpEnabled: true,
    smsEnabled: false,
    required: 'off',
    requiredRoles: [],
    webauthnEnabled: true,
    passkeyLoginEnabled: true,
    requireDrivers: false,
  })),
  isRoamingEnabled: vi.fn(async () => false),
  getSsoConfig: vi.fn(async () => null),
  isSupportAiEnabled: vi.fn(async () => false),
  getPasswordPolicy: vi.fn(async () => ({
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSymbol: false,
  })),
}));

import { securityPublicRoutes } from '../routes/security-public.js';
import { portalHostAllowsPasskeys } from '../lib/webauthn-rp.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  securityPublicRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  state.portalUrl = 'https://portal.example.com';
});

async function publicConfig(query: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'GET', url: `/security/public${query}` });
  expect(res.statusCode).toBe(200);
  return res.json<Record<string, unknown>>();
}

describe('GET /security/public passkeys by app', () => {
  it('reports passkeys to the portal on a domain name', async () => {
    expect(await publicConfig('?app=portal')).toMatchObject({
      webauthnEnabled: true,
      passkeyLoginEnabled: true,
    });
  });

  it('reports passkeys off to the portal while it is served from an IP address', async () => {
    state.portalUrl = 'http://192.168.1.20:7101';
    expect(await publicConfig('?app=portal')).toMatchObject({
      webauthnEnabled: false,
      passkeyLoginEnabled: false,
    });
    state.portalUrl = 'https://[fd00::1]:7101';
    expect(await publicConfig('?app=portal')).toMatchObject({ webauthnEnabled: false });
  });

  it('keeps the setting for the CSMS and for a caller that names no app', async () => {
    state.portalUrl = 'http://192.168.1.20:7101';
    expect(await publicConfig('?app=csms')).toMatchObject({ webauthnEnabled: true });
    expect(await publicConfig('')).toMatchObject({ webauthnEnabled: true });
  });

  it('refuses an unknown app with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/security/public?app=mobile' });
    expect(res.statusCode).toBe(400);
  });
});

describe('portalHostAllowsPasskeys', () => {
  it('allows a domain name and localhost, refuses IP literals', () => {
    expect(portalHostAllowsPasskeys('https://portal.example.com')).toBe(true);
    expect(portalHostAllowsPasskeys('http://localhost:7101')).toBe(true);
    expect(portalHostAllowsPasskeys('http://10.0.0.5:7101')).toBe(false);
    expect(portalHostAllowsPasskeys('https://[::1]:7101')).toBe(false);
    expect(portalHostAllowsPasskeys('not a url')).toBe(false);
  });
});
