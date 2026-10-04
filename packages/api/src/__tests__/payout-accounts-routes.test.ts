// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

const SITE_ID = 'sit_000000000001';
const OTHER_SITE_ID = 'sit_000000000002';

const m = vi.hoisted(() => ({
  siteRows: [] as unknown[],
  createSitePayoutAccount: vi.fn(),
  createSitePayoutOnboardingLink: vi.fn(),
  findSitePayoutAccount: vi.fn(),
  refreshSitePayoutAccount: vi.fn(),
  createPayoutInvite: vi.fn(),
  openPayoutInvite: vi.fn(),
  resolvePayoutInvite: vi.fn(),
  revokePayoutInvites: vi.fn(),
  getUserSiteIds: vi.fn(),
  writeAudit: vi.fn(),
  clearPaymentCaches: vi.fn(),
}));

vi.mock('@evtivity/database', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(m.siteRows),
  };
  return { ...actual, db: { select: vi.fn(() => chain) }, writeAudit: m.writeAudit };
});

vi.mock('@evtivity/payments', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createSitePayoutAccount: m.createSitePayoutAccount,
    createSitePayoutOnboardingLink: m.createSitePayoutOnboardingLink,
    findSitePayoutAccount: m.findSitePayoutAccount,
    refreshSitePayoutAccount: m.refreshSitePayoutAccount,
  };
});

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
  invalidatePermissionCache: vi.fn(),
}));

vi.mock('../lib/payments.js', () => ({
  paymentContext: (logger: unknown) => ({ registry: 'registry', logger }),
  clearPaymentCaches: m.clearPaymentCaches,
}));
vi.mock('../lib/site-access.js', () => ({ getUserSiteIds: m.getUserSiteIds }));
vi.mock('../services/payout-onboarding.service.js', () => ({
  createPayoutInvite: m.createPayoutInvite,
  openPayoutInvite: m.openPayoutInvite,
  resolvePayoutInvite: m.resolvePayoutInvite,
  revokePayoutInvites: m.revokePayoutInvites,
  payoutOnboardingUrl: (token: string) => `https://portal.test/payout-onboarding?token=${token}`,
  payoutOnboardingReturnUrl: (token: string) =>
    `https://portal.test/payout-onboarding/return?token=${token}`,
}));

import { AppError } from '@evtivity/lib';
import {
  PaymentProviderNotConfiguredError,
  PaymentProviderPermissionError,
  PaymentProviderUnavailableError,
  PaymentValidationError,
} from '@evtivity/payments';
import { registerAuth } from '../plugins/auth.js';
import { payoutAccountRoutes } from '../routes/payout-accounts.js';
import { portalPayoutOnboardingRoutes } from '../routes/portal/payout-onboarding.js';

const site = {
  id: SITE_ID,
  name: 'Main Street',
  country: 'United States',
  contactEmail: 'host@example.com',
};

const onboardingStatus = {
  accountId: 'acct_1',
  state: 'onboarding',
  capabilities: { card_payments: 'inactive', transfers: 'inactive' },
  detailsSubmitted: false,
  requirementsDue: ['business_type'],
  disabledReason: null,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    void reply.send(error);
  });
  await registerAuth(app);
  payoutAccountRoutes(app);
  portalPayoutOnboardingRoutes(app);
  await app.ready();
  return app;
}

describe('payout account routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    m.siteRows = [site];
    m.getUserSiteIds.mockResolvedValue(null);
    m.openPayoutInvite.mockResolvedValue(null);
    m.findSitePayoutAccount.mockResolvedValue({
      configId: 3,
      siteId: SITE_ID,
      accountId: 'acct_1',
      status: 'onboarding',
      details: {
        capabilities: { card_payments: 'inactive', transfers: 'inactive' },
        detailsSubmitted: false,
        requirementsDue: ['business_type'],
        disabledReason: null,
      },
      checkedAt: new Date('2026-10-03T12:00:00Z'),
      updatedAt: new Date('2026-10-03T11:00:00Z'),
    });
  });

  function inject(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload != null ? { payload } : {}),
    });
  }

  describe('GET /sites/:id/payout-account', () => {
    it('returns the account, its status and the open invite', async () => {
      m.openPayoutInvite.mockResolvedValue({
        expiresAt: new Date('2026-10-10T00:00:00Z'),
        sentTo: 'host@example.com',
        lastUsedAt: null,
      });
      const res = await inject('GET', `/sites/${SITE_ID}/payout-account`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        accountId: 'acct_1',
        status: 'onboarding',
        details: { requirementsDue: ['business_type'] },
        checkedAt: '2026-10-03T12:00:00.000Z',
        invite: { expiresAt: '2026-10-10T00:00:00.000Z', sentTo: 'host@example.com' },
      });
    });

    it('answers 404 for a site outside the operator sites', async () => {
      m.getUserSiteIds.mockResolvedValue([OTHER_SITE_ID]);
      const res = await inject('GET', `/sites/${SITE_ID}/payout-account`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('SITE_NOT_FOUND');
      expect(m.findSitePayoutAccount).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown site', async () => {
      m.siteRows = [];
      const res = await inject('GET', `/sites/${SITE_ID}/payout-account`);
      expect(res.statusCode).toBe(404);
    });

    it('needs authentication', async () => {
      const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/payout-account` });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /sites/:id/payout-account', () => {
    it("creates the account with the site's name, contact email and country, and audits it", async () => {
      m.createSitePayoutAccount.mockResolvedValue({ outcome: 'created', accountId: 'acct_1' });
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json().accountId).toBe('acct_1');
      expect(m.createSitePayoutAccount).toHaveBeenCalledWith(
        SITE_ID,
        { displayName: 'Main Street', contactEmail: 'host@example.com', country: 'US' },
        expect.objectContaining({ registry: 'registry' }),
      );
      expect(m.clearPaymentCaches).toHaveBeenCalled();
      expect(m.writeAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityId: SITE_ID,
          action: 'payment_config_changed',
          after: { stripeConnectedAccountId: 'acct_1' },
          notes: 'Payout account created',
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    it("uses the body's country over the site's", async () => {
      m.createSitePayoutAccount.mockResolvedValue({ outcome: 'created', accountId: 'acct_1' });
      await inject('POST', `/sites/${SITE_ID}/payout-account`, { country: 'de' });
      expect(m.createSitePayoutAccount).toHaveBeenCalledWith(
        SITE_ID,
        expect.objectContaining({ country: 'DE' }),
        expect.anything(),
      );
    });

    it('answers 400 VALIDATION_ERROR when no country resolves', async () => {
      m.siteRows = [{ ...site, country: 'Atlantis' }];
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account`, {});
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(res.json().details.country).toBeDefined();
      expect(m.createSitePayoutAccount).not.toHaveBeenCalled();
    });

    it("uses the body's contact email over the site's", async () => {
      m.createSitePayoutAccount.mockResolvedValue({ outcome: 'created', accountId: 'acct_1' });
      await inject('POST', `/sites/${SITE_ID}/payout-account`, {
        contactEmail: 'owner@example.com',
      });
      expect(m.createSitePayoutAccount).toHaveBeenCalledWith(
        SITE_ID,
        expect.objectContaining({ contactEmail: 'owner@example.com' }),
        expect.anything(),
      );
    });

    it.each([null, ''])(
      'answers 400 VALIDATION_ERROR without a contact email (site email %j) before calling Stripe',
      async (contactEmail) => {
        m.siteRows = [{ ...site, contactEmail }];
        const res = await inject('POST', `/sites/${SITE_ID}/payout-account`, {});
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
        expect(res.json().details.contactEmail).toBeDefined();
        expect(m.createSitePayoutAccount).not.toHaveBeenCalled();
      },
    );

    it('rejects a contact email that is not an email address', async () => {
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account`, {
        contactEmail: 'not-an-email',
      });
      expect(res.statusCode).toBe(400);
      expect(m.createSitePayoutAccount).not.toHaveBeenCalled();
    });

    it('answers 409 PAYOUT_ACCOUNT_EXISTS when the site has an account', async () => {
      m.createSitePayoutAccount.mockResolvedValue({ outcome: 'exists', accountId: 'acct_old' });
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account`, {});
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'PAYOUT_ACCOUNT_EXISTS', accountId: 'acct_old' });
      expect(m.writeAudit).not.toHaveBeenCalled();
    });

    it.each([
      [new PaymentProviderNotConfiguredError('stripe'), 'PAYMENT_PROVIDER_NOT_CONFIGURED'],
      [
        new PaymentProviderPermissionError('stripe', 'Connect: write'),
        'PAYMENT_PROVIDER_PERMISSION_MISSING',
      ],
      [
        new PaymentValidationError('Please review the responsibilities of managing losses'),
        'PAYMENT_PROVIDER_CONNECTION_FAILED',
      ],
      [new PaymentProviderUnavailableError('Stripe down'), 'PAYMENT_PROVIDER_CONNECTION_FAILED'],
    ])('maps %s to 400 %s', async (err, code) => {
      m.createSitePayoutAccount.mockRejectedValue(err);
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account`, {});
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
    });

    it('answers 400 when the provider cannot create accounts', async () => {
      m.createSitePayoutAccount.mockResolvedValue({ outcome: 'not_supported' });
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account`, {});
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
    });

    it('lets an unexpected error reach the error handler', async () => {
      m.createSitePayoutAccount.mockRejectedValue(new Error('db down'));
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account`, {});
      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /sites/:id/payout-account/refresh', () => {
    it('reads the status and keeps the invite while not active', async () => {
      m.refreshSitePayoutAccount.mockResolvedValue(onboardingStatus);
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account/refresh`);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('onboarding');
      expect(m.revokePayoutInvites).not.toHaveBeenCalled();
    });

    it('revokes the open invite once the account is active', async () => {
      m.refreshSitePayoutAccount.mockResolvedValue({ ...onboardingStatus, state: 'active' });
      await inject('POST', `/sites/${SITE_ID}/payout-account/refresh`);
      expect(m.revokePayoutInvites).toHaveBeenCalledWith(SITE_ID);
    });

    it('answers 409 PAYOUT_ACCOUNT_NOT_READY without an account', async () => {
      m.refreshSitePayoutAccount.mockResolvedValue(null);
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account/refresh`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('PAYOUT_ACCOUNT_NOT_READY');
    });
  });

  describe('POST /sites/:id/payout-account/invite', () => {
    it('creates the invite with the operator as actor', async () => {
      const expiresAt = new Date('2026-10-10T00:00:00Z');
      m.createPayoutInvite.mockResolvedValue({
        url: 'https://portal.test/payout-onboarding?token=abc',
        expiresAt,
        sentTo: 'host@example.com',
      });
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account/invite`, {
        send: 'email',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        url: 'https://portal.test/payout-onboarding?token=abc',
        expiresAt: '2026-10-10T00:00:00.000Z',
        sentTo: 'host@example.com',
      });
      expect(m.createPayoutInvite).toHaveBeenCalledWith(
        SITE_ID,
        { send: 'email' },
        expect.objectContaining({
          actor: expect.objectContaining({ actor: 'operator', actorUserId: 'usr_000000000001' }),
        }),
      );
    });

    it('passes the service errors through', async () => {
      m.createPayoutInvite.mockRejectedValue(
        new AppError('The site has no contact email address', 400, 'EMAIL_REQUIRED'),
      );
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account/invite`, {
        send: 'email',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('EMAIL_REQUIRED');
    });

    it('validates the send mode', async () => {
      const res = await inject('POST', `/sites/${SITE_ID}/payout-account/invite`, {
        send: 'sms',
      });
      expect(res.statusCode).toBe(400);
      expect(m.createPayoutInvite).not.toHaveBeenCalled();
    });
  });
});

describe('portal payout onboarding routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    m.resolvePayoutInvite.mockResolvedValue({ siteId: SITE_ID });
  });

  function post(path: string, token = 'tok123') {
    return app.inject({ method: 'POST', url: path, payload: { token } });
  }

  it('mints a Stripe link with the onboarding page as refresh and the return page', async () => {
    m.createSitePayoutOnboardingLink.mockResolvedValue({
      outcome: 'link',
      url: 'https://connect.stripe.com/setup/x',
      expiresAt: new Date(),
    });
    const res = await post('/portal/payout-onboarding/link');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://connect.stripe.com/setup/x', status: null });
    expect(m.resolvePayoutInvite).toHaveBeenCalledWith('tok123');
    expect(m.createSitePayoutOnboardingLink).toHaveBeenCalledWith(
      SITE_ID,
      {
        refreshUrl: 'https://portal.test/payout-onboarding?token=tok123',
        returnUrl: 'https://portal.test/payout-onboarding/return?token=tok123',
      },
      expect.anything(),
    );
  });

  it('answers active without a link for an active account', async () => {
    m.createSitePayoutOnboardingLink.mockResolvedValue({ outcome: 'active' });
    const res = await post('/portal/payout-onboarding/link');
    expect(res.json()).toEqual({ url: null, status: 'active' });
  });

  it('answers 400 INVALID_TOKEN for a bad link', async () => {
    m.resolvePayoutInvite.mockRejectedValue(
      new AppError('Invalid or expired onboarding link', 400, 'INVALID_TOKEN'),
    );
    const res = await post('/portal/payout-onboarding/link');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TOKEN');
    expect(m.createSitePayoutOnboardingLink).not.toHaveBeenCalled();
  });

  it('answers 400 INVALID_TOKEN when the account was removed', async () => {
    m.createSitePayoutOnboardingLink.mockResolvedValue({ outcome: 'no_account' });
    const res = await post('/portal/payout-onboarding/link');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TOKEN');
  });

  it('answers 400 when Stripe is not configured', async () => {
    m.createSitePayoutOnboardingLink.mockRejectedValue(
      new PaymentProviderNotConfiguredError('stripe'),
    );
    const res = await post('/portal/payout-onboarding/link');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');
  });

  it('answers only the state on the return page', async () => {
    m.refreshSitePayoutAccount.mockResolvedValue({ ...onboardingStatus, state: 'pending' });
    const res = await post('/portal/payout-onboarding/status');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pending' });
  });

  it('answers 400 INVALID_TOKEN on the return page without an account', async () => {
    m.refreshSitePayoutAccount.mockResolvedValue(null);
    const res = await post('/portal/payout-onboarding/status');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TOKEN');
  });

  it('requires a token', async () => {
    const res = await post('/portal/payout-onboarding/status', '');
    expect(res.statusCode).toBe(400);
    expect(m.resolvePayoutInvite).not.toHaveBeenCalled();
  });
});
