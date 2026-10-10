// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Company-wide configuration (pricing, holidays, notification settings and
// log, alert rules, station message templates, conformance runs, system,
// security, SSO and Plug and Charge settings) spans every site: a
// site-restricted user gets the route's 404 before any read or write.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

vi.mock('../lib/site-access.js', async () =>
  (await import('./helpers/site-access-mock.js')).siteAccessMock(),
);

// Any database access fails the test: the guard answers before it.
const { dbCall } = vi.hoisted(() => ({
  dbCall: vi.fn(() => {
    throw new Error('the database must not be read or written');
  }),
}));
vi.mock('@evtivity/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@evtivity/database')>()),
  db: { select: dbCall, insert: dbCall, update: dbCall, delete: dbCall, execute: dbCall },
}));

// The local contract CA helpers: never reached, the guard answers first.
vi.mock('@evtivity/ocpp', () => ({
  createLocalContractCa: dbCall,
  describeLocalContractCa: dbCall,
  parseLocalContractCa: dbCall,
}));

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

import { registerAuth } from '../plugins/auth.js';
import { pricingRoutes } from '../routes/pricing.js';
import { holidayRoutes } from '../routes/holidays.js';
import { notificationRoutes } from '../routes/notifications.js';
import { eventAlertRuleRoutes } from '../routes/event-alert-rules.js';
import { stationMessageTemplateRoutes } from '../routes/station-message-templates.js';
import { octtRoutes } from '../routes/octt.js';
import { driverRoutes } from '../routes/drivers.js';
import { fleetRoutes } from '../routes/fleets.js';
import { settingsRoutes } from '../routes/settings.js';
import { securitySettingsRoutes } from '../routes/security-settings.js';
import { ssoSettingsRoutes } from '../routes/sso-settings.js';
import { pncSettingsRoutes } from '../routes/pnc-settings.js';
import { pncLocalRoutes } from '../routes/pnc-local.js';
import { resetSiteAccessMock, setMockUserSiteIds } from './helpers/site-access-mock.js';

const PG = 'pgr_000000000001';
const TARIFF = 'trf_000000000001';

const cases: Array<[string, string, string]> = [
  ['POST', '/pricing-groups', 'PRICING_GROUP_NOT_FOUND'],
  ['PATCH', `/pricing-groups/${PG}`, 'PRICING_GROUP_NOT_FOUND'],
  ['DELETE', `/pricing-groups/${PG}`, 'PRICING_GROUP_NOT_FOUND'],
  ['POST', `/pricing-groups/${PG}/tariffs`, 'TARIFF_NOT_FOUND'],
  ['PATCH', `/pricing-groups/${PG}/tariffs/${TARIFF}`, 'TARIFF_NOT_FOUND'],
  ['DELETE', `/pricing-groups/${PG}/tariffs/${TARIFF}`, 'TARIFF_NOT_FOUND'],
  ['GET', '/pricing-audit', 'PRICING_NOT_FOUND'],
  ['POST', '/pricing-holidays', 'HOLIDAY_NOT_FOUND'],
  ['DELETE', '/pricing-holidays/1', 'HOLIDAY_NOT_FOUND'],
  ['POST', '/pricing-holidays/bulk', 'HOLIDAY_NOT_FOUND'],
  ['PUT', '/ocpp-event-settings', 'SETTING_NOT_FOUND'],
  ['DELETE', '/ocpp-event-settings?eventType=x&channel=email', 'SETTING_NOT_FOUND'],
  ['GET', '/notifications', 'MESSAGE_NOT_FOUND'],
  ['PUT', '/driver-event-settings', 'SETTING_NOT_FOUND'],
  ['PUT', '/notification-templates', 'TEMPLATE_NOT_FOUND'],
  ['DELETE', '/notification-templates?eventType=x&channel=email&language=en', 'TEMPLATE_NOT_FOUND'],
  ['POST', '/event-alert-rules', 'RULE_NOT_FOUND'],
  ['PATCH', '/event-alert-rules/1', 'RULE_NOT_FOUND'],
  ['DELETE', '/event-alert-rules/1', 'RULE_NOT_FOUND'],
  ['PUT', '/station-message-templates/charging', 'TEMPLATE_NOT_FOUND'],
  ['DELETE', '/station-message-templates/charging', 'TEMPLATE_NOT_FOUND'],
  ['POST', '/octt/runs', 'OCTT_RUN_NOT_FOUND'],
  ['POST', '/notifications/test', 'SETTING_NOT_FOUND'],
  ['POST', '/drivers/drv_000000000001/pricing-groups', 'PRICING_GROUP_NOT_FOUND'],
  ['DELETE', `/drivers/drv_000000000001/pricing-groups/${PG}`, 'PRICING_GROUP_NOT_FOUND'],
  ['POST', '/fleets/flt_000000000001/pricing-groups', 'PRICING_GROUP_NOT_FOUND'],
  ['DELETE', `/fleets/flt_000000000001/pricing-groups/${PG}`, 'PRICING_GROUP_NOT_FOUND'],
  // Generic settings: every key outside the restricted allowlist.
  ['GET', '/settings/stripe.secretKeyEnc', 'SETTING_NOT_FOUND'],
  ['GET', '/settings/smtp.passwordEnc', 'SETTING_NOT_FOUND'],
  ['PATCH', '/settings/company.currency', 'SETTING_NOT_FOUND'],
  ['PUT', '/settings/payments.provider', 'SETTING_NOT_FOUND'],
  ['PUT', '/settings/smtp.host', 'SETTING_NOT_FOUND'],
  ['PUT', '/settings/twilio.authTokenEnc', 'SETTING_NOT_FOUND'],
  ['DELETE', '/settings/prepaid.lowCreditThresholdCents', 'SETTING_NOT_FOUND'],
  ['GET', '/settings/s3/status', 'SETTING_NOT_FOUND'],
  ['PUT', '/settings/s3', 'SETTING_NOT_FOUND'],
  ['POST', '/settings/s3/test', 'SETTING_NOT_FOUND'],
  ['GET', '/sso/settings', 'SETTING_NOT_FOUND'],
  ['PUT', '/sso/settings', 'SETTING_NOT_FOUND'],
  ['GET', '/security/settings', 'SETTING_NOT_FOUND'],
  ['PUT', '/security/recaptcha', 'SETTING_NOT_FOUND'],
  ['PUT', '/security/mfa', 'SETTING_NOT_FOUND'],
  ['GET', '/pnc/settings', 'SETTING_NOT_FOUND'],
  ['PUT', '/pnc/settings', 'SETTING_NOT_FOUND'],
  ['POST', '/pnc/settings/test-provider', 'SETTING_NOT_FOUND'],
  ['GET', '/pnc/settings/local-ca', 'SETTING_NOT_FOUND'],
  ['POST', '/pnc/settings/local-ca', 'SETTING_NOT_FOUND'],
];

describe('company-wide configuration for a site-restricted user', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await registerAuth(app);
    // The guard runs in the handler, after validation: accept any body so each
    // case reaches it without a route-specific payload.
    app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
    pricingRoutes(app);
    holidayRoutes(app);
    notificationRoutes(app);
    eventAlertRuleRoutes(app);
    stationMessageTemplateRoutes(app);
    octtRoutes(app);
    driverRoutes(app);
    fleetRoutes(app);
    settingsRoutes(app);
    securitySettingsRoutes(app);
    ssoSettingsRoutes(app);
    pncSettingsRoutes(app);
    pncLocalRoutes(app);
    await app.ready();
    token = app.jwt.sign({ userId: 'usr_000000000001', roleId: 'rol_000000000001' });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    dbCall.mockClear();
  });

  afterEach(() => {
    resetSiteAccessMock();
  });

  it.each(cases)('%s %s answers 404 %s', async (method, url, code) => {
    setMockUserSiteIds(['sit_000000000001']);

    const response = await app.inject({
      method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code });
    expect(dbCall).not.toHaveBeenCalled();
  });

  it('answers 404 for a user assigned to no site', async () => {
    setMockUserSiteIds([]);

    const response = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    expect(dbCall).not.toHaveBeenCalled();
  });

  it('lets a user with access to every site reach the handler', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { authorization: `Bearer ${token}` },
    });

    // The handler ran and read the (failing) database.
    expect(dbCall).toHaveBeenCalled();
    expect(response.statusCode).toBe(500);
  });
});
