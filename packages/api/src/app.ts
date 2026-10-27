// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { deriveKey, KEY_LABELS } from '@evtivity/lib/derived-keys';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { AppError } from '@evtivity/lib';
import type { Redis } from 'ioredis';
import {
  db,
  isRoamingEnabled,
  isPncEnabled,
  isReservationEnabled,
  isSupportEnabled,
  isFleetEnabled,
  isGuestChargingEnabled,
} from '@evtivity/database';
import { drivers } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import { registerApiAccessLog } from './plugins/api-access-log.js';
import { registerCors } from './plugins/cors.js';
import { frameworkClientError, sendRouteNotFound } from './lib/framework-error.js';
import {
  CSRF_SKIP_METHODS,
  csrfTokensMatch,
  refuseCrossSiteSignIn,
  registerPortalCsrf,
} from './plugins/csrf.js';
import { registerEncodedPathGuard, routePath } from './plugins/encoded-path-guard.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerAccountNoStore } from './plugins/account-no-store.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerAiToolCallContext } from './services/ai/tools/execute.js';
import { registerAuth } from './plugins/auth.js';
import { config } from './lib/config.js';
import { WeakPasswordError } from './lib/password-validation.js';
import { DataPlanSettingInTemplateError } from './lib/station-credential-guard.js';
import { registerOpenApi } from './plugins/openapi.js';
import { registerResponseCache, cacheRoutes } from './plugins/response-cache.js';
import { healthRoutes } from './routes/health.js';
import { siteRoutes } from './routes/sites.js';
import { stationRoutes } from './routes/stations.js';
import { stationSimRoutes } from './routes/station-sim.js';
import { simRoutes } from './routes/sims.js';
import { sessionRoutes } from './routes/sessions.js';
import { userRoutes } from './routes/users.js';
import { userAvatarRoutes } from './routes/user-avatar.js';
import { webauthnRoutes } from './routes/webauthn.js';
import { userDashboardLayoutRoutes } from './routes/user-dashboard-layout.js';
import { driverRoutes } from './routes/drivers.js';
import { driverAvatarRoutes } from './routes/driver-avatar.js';
import { pricingRoutes } from './routes/pricing.js';
import { holidayRoutes } from './routes/holidays.js';
import { ocppCommandRoutes } from './routes/ocpp-commands.js';
import { ocppSchemaRoutes } from './routes/ocpp-schemas.js';
import { transactionRoutes } from './routes/transactions.js';
import { fleetRoutes } from './routes/fleets.js';
import { tokenRoutes } from './routes/tokens.js';
import { authorizeAttemptRoutes } from './routes/authorize-attempts.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { settingsRoutes } from './routes/settings.js';
import { aiDefaultsRoutes } from './routes/ai-defaults.js';
import { docsSearchRoutes } from './routes/docs-search.js';
import { paymentRoutes } from './routes/payments.js';
import { adyenSettingsRoutes } from './routes/adyen-settings.js';
import { payoutAccountRoutes } from './routes/payout-accounts.js';
import { paymentSettingsRoutes } from './routes/payment-settings.js';
import { eventStreamRoutes } from './routes/events.js';
import { loadManagementRoutes } from './routes/load-management.js';
import { notificationRoutes } from './routes/notifications.js';
import { portalAuthRoutes } from './routes/portal/auth.js';
import { portalDriverRoutes } from './routes/portal/driver.js';
import { portalWebauthnRoutes } from './routes/portal/webauthn.js';
import { portalDriverAvatarRoutes } from './routes/portal/driver-avatar.js';
import { portalPaymentRoutes } from './routes/portal/payments.js';
import { portalPaymentProviderRoutes } from './routes/portal/payment-provider.js';
import { portalSessionRoutes } from './routes/portal/sessions.js';
import { portalChargerRoutes } from './routes/portal/charger.js';
import { portalGuestRoutes } from './routes/portal/guest.js';
import { portalPayoutOnboardingRoutes } from './routes/portal/payout-onboarding.js';
import { reservationRoutes } from './routes/reservations.js';
import { maintenanceRoutes, maintenancePreviewRoutes } from './routes/maintenance.js';
import { accessLogRoutes } from './routes/access-logs.js';
import { displayMessageRoutes } from './routes/display-messages.js';
import { reportRoutes } from './routes/reports.js';
import { neviRoutes } from './routes/nevi.js';
import { webhookRoutes } from './routes/webhooks.js';
import { invoiceRoutes } from './routes/invoices.js';
import { fleetInvoiceRoutes } from './routes/fleet-invoices.js';
import { adHocPaymentRoutes } from './routes/ad-hoc-payments.js';
import { stationWebPaymentRoutes } from './routes/station-web-payments.js';
import { supportCaseRoutes } from './routes/support-cases.js';
import { portalSupportCaseRoutes } from './routes/portal/support-cases.js';
import { portalVehicleRoutes } from './routes/portal/vehicles.js';
import { portalInvoiceRoutes } from './routes/portal/invoices.js';
import { portalTokenRoutes } from './routes/portal/tokens.js';
import { portalNotificationRoutes } from './routes/portal/notifications.js';
import { portalRoamingChargerRoutes } from './routes/portal/roaming-chargers.js';
import { portalEventRoutes } from './routes/portal/events.js';
import { portalStationEventRoutes } from './routes/portal/station-events.js';
import { portalFavoriteRoutes } from './routes/portal/favorites.js';
import { portalStationWatchRoutes } from './routes/portal/station-watches.js';
import { ocpiPartnerRoutes } from './routes/ocpi-partners.js';
import { ocpiLocationRoutes } from './routes/ocpi-locations.js';
import { ocpiSessionRoutes } from './routes/ocpi-sessions.js';
import { ocpiCdrRoutes } from './routes/ocpi-cdrs.js';
import { ocpiTariffRoutes } from './routes/ocpi-tariffs.js';
import { pncSettingsRoutes } from './routes/pnc-settings.js';
import { simProviderSettingsRoutes } from './routes/sim-provider-settings.js';
import { dataRetentionSettingsRoutes } from './routes/data-retention-settings.js';
import { aiInsightScopeRoutes } from './routes/ai-insight-scope.js';
import { pncCertificateRoutes } from './routes/pnc-certificates.js';
import { pncLocalRoutes } from './routes/pnc-local.js';
import { securitySettingsRoutes } from './routes/security-settings.js';
import { securityPublicRoutes } from './routes/security-public.js';
import { systemRoutes } from './routes/system.js';
import { ssoSettingsRoutes } from './routes/sso-settings.js';
import { ssoAuthRoutes } from './routes/sso-auth.js';
import { carbonRoutes } from './routes/carbon.js';
import { localAuthListRoutes } from './routes/local-auth-list.js';
import { firmwareCampaignRoutes } from './routes/firmware-campaigns.js';
import { configTemplateRoutes } from './routes/config-templates.js';
import { eventAlertRuleRoutes } from './routes/event-alert-rules.js';
import { workerLogRoutes } from './routes/worker-logs.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { stationImageRoutes } from './routes/station-images.js';
import { stationMessageTemplateRoutes } from './routes/station-message-templates.js';
import { fleetReservationRoutes } from './routes/fleet-reservations.js';
import { cssRoutes } from './routes/css.js';
import { smartChargingRoutes } from './routes/smart-charging.js';
import { panelRoutes } from './routes/panels.js';
import { circuitRoutes } from './routes/circuits.js';
import { unmanagedLoadRoutes } from './routes/unmanaged-loads.js';
import { assistantRoutes } from './routes/assistant.js';
import { aiUsageRoutes } from './routes/ai-usage.js';
import { aiAlertsRoutes } from './routes/ai-alerts.js';
import { mcpRoutes } from './routes/mcp.js';
import { aiInsightRoutes } from './routes/ai-insights.js';
import { assistantAttachmentRoutes } from './routes/assistant-attachments.js';
import { octtRoutes } from './routes/octt.js';
import { auditRoutes } from './routes/audit.js';
import { entityNeighborRoutes } from './routes/entity-neighbors.js';

export interface BuildAppOptions extends FastifyServerOptions {
  /** Shared rate limit counters (the API server passes one; see registerRateLimit). */
  rateLimitRedis?: Redis;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { rateLimitRedis, ...opts } = options;
  // Default body size limit: 1 MB. Individual routes can override with
  // route-level bodyLimit for endpoints that accept larger payloads
  // (e.g., certificate PEM uploads, bulk imports).
  const app = Fastify({ bodyLimit: 1_048_576, ...opts });

  // First: every later hook decides on the path, so an encoded path never reaches them.
  registerEncodedPathGuard(app);
  registerAccountNoStore(app);

  // Plugins
  // Cookies are signed with their own key, derived from JWT_SECRET.
  await app.register(cookie, {
    secret: deriveKey(config.JWT_SECRET, KEY_LABELS.cookies),
  });
  await registerCors(app);
  await registerHelmet(app);
  // First: the rate limiter and the audit writes read the AI tool call context.
  registerAiToolCallContext(app);
  // The server process counts in Redis, one limit for every API replica.
  // Tests and the spec generators keep per-instance counters.
  await registerRateLimit(app, rateLimitRedis != null ? { redis: rateLimitRedis } : {});
  // System Information reports whether the counters are shared (routes/system.ts).
  app.decorate('sharedRateLimit', rateLimitRedis != null);
  await registerAuth(app);
  await registerOpenApi(app);
  registerResponseCache(app);

  // Error handler
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof WeakPasswordError) {
      void reply
        .status(error.statusCode)
        .send({ error: error.message, code: error.code, missing: error.missing });
      return;
    }
    if (error instanceof DataPlanSettingInTemplateError) {
      void reply.status(error.statusCode).send({
        error: error.message,
        code: error.code,
        details: { variables: error.variables },
      });
      return;
    }
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    // Framework 4xx (schema validation, body parser, JWT, rate limit), coded by status.
    const client = frameworkClientError(error);
    if (client != null) {
      void reply.status(client.status).send(client.body);
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
  app.setNotFoundHandler(sendRouteNotFound);

  // Routes
  await app.register(healthRoutes);

  // All versioned routes under /v1
  await app.register(
    async function v1Routes(v1) {
      await v1.register(siteRoutes);
      await v1.register(stationRoutes);
      await v1.register(stationSimRoutes);
      await v1.register(simRoutes);
      await v1.register(sessionRoutes);
      await v1.register(userRoutes);
      await v1.register(userAvatarRoutes);
      await v1.register(webauthnRoutes);
      await v1.register(userDashboardLayoutRoutes);
      await v1.register(driverRoutes);
      await v1.register(driverAvatarRoutes);
      await v1.register(pricingRoutes);
      await v1.register(holidayRoutes);
      await v1.register(ocppCommandRoutes);
      await v1.register(ocppSchemaRoutes);
      await v1.register(transactionRoutes);
      await v1.register(fleetRoutes);
      await v1.register(tokenRoutes);
      await v1.register(authorizeAttemptRoutes);
      await v1.register(dashboardRoutes);
      await v1.register(settingsRoutes);
      await v1.register(aiDefaultsRoutes);
      await v1.register(docsSearchRoutes);
      await v1.register(paymentRoutes);
      await v1.register(adyenSettingsRoutes);
      await v1.register(payoutAccountRoutes);
      await v1.register(paymentSettingsRoutes);
      await v1.register(eventStreamRoutes);
      await v1.register(loadManagementRoutes);
      await v1.register(notificationRoutes);
      await v1.register(reservationRoutes);
      await v1.register(maintenanceRoutes);
      await v1.register(maintenancePreviewRoutes);
      await v1.register(portalAuthRoutes);
      await v1.register(portalDriverRoutes);
      await v1.register(portalWebauthnRoutes);
      await v1.register(portalDriverAvatarRoutes);
      await v1.register(portalPaymentRoutes);
      await v1.register(portalPaymentProviderRoutes);
      await v1.register(portalSessionRoutes);
      await v1.register(portalChargerRoutes);
      await v1.register(portalGuestRoutes);
      await v1.register(portalPayoutOnboardingRoutes);
      await v1.register(accessLogRoutes);
      await v1.register(displayMessageRoutes);
      await v1.register(reportRoutes);
      await v1.register(neviRoutes);
      await v1.register(webhookRoutes);
      await v1.register(invoiceRoutes);
      await v1.register(fleetInvoiceRoutes);
      await v1.register(adHocPaymentRoutes);
      await v1.register(stationWebPaymentRoutes);
      await v1.register(supportCaseRoutes);
      await v1.register(portalVehicleRoutes);
      await v1.register(portalInvoiceRoutes);
      await v1.register(portalTokenRoutes);
      await v1.register(portalNotificationRoutes);
      await v1.register(portalSupportCaseRoutes);
      await v1.register(portalRoamingChargerRoutes);
      await v1.register(portalEventRoutes);
      await v1.register(portalStationEventRoutes);
      await v1.register(portalFavoriteRoutes);
      await v1.register(portalStationWatchRoutes);
      await v1.register(ocpiPartnerRoutes);
      await v1.register(ocpiLocationRoutes);
      await v1.register(ocpiSessionRoutes);
      await v1.register(ocpiCdrRoutes);
      await v1.register(ocpiTariffRoutes);
      await v1.register(pncSettingsRoutes);
      await v1.register(simProviderSettingsRoutes);
      await v1.register(dataRetentionSettingsRoutes);
      await v1.register(aiInsightScopeRoutes);
      await v1.register(pncCertificateRoutes);
      await v1.register(pncLocalRoutes);
      await v1.register(securitySettingsRoutes);
      await v1.register(securityPublicRoutes);
      await v1.register(systemRoutes);
      await v1.register(ssoSettingsRoutes);
      await v1.register(ssoAuthRoutes);
      await v1.register(carbonRoutes);
      await v1.register(localAuthListRoutes);
      await v1.register(firmwareCampaignRoutes);
      await v1.register(configTemplateRoutes);
      await v1.register(eventAlertRuleRoutes);
      await v1.register(workerLogRoutes);
      await v1.register(apiKeyRoutes);
      await v1.register(stationImageRoutes);
      await v1.register(stationMessageTemplateRoutes);
      await v1.register(fleetReservationRoutes);
      await v1.register(cssRoutes);
      await v1.register(smartChargingRoutes);
      await v1.register(panelRoutes);
      await v1.register(circuitRoutes);
      await v1.register(unmanagedLoadRoutes);
      await v1.register(assistantRoutes);
      await v1.register(aiUsageRoutes);
      await v1.register(aiAlertsRoutes);
      await v1.register(mcpRoutes);
      await v1.register(aiInsightRoutes);
      await v1.register(assistantAttachmentRoutes);
      await v1.register(octtRoutes);
      await v1.register(auditRoutes);
      await v1.register(cacheRoutes);
      await v1.register(entityNeighborRoutes);
    },
    { prefix: '/v1' },
  );

  // Block OCPI management and portal roaming routes when roaming is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = routePath(request);
    if (!url.startsWith('/v1/ocpi/') && !url.startsWith('/v1/portal/chargers/roaming')) return;
    const enabled = await isRoamingEnabled();
    if (!enabled) {
      await reply.status(403).send({ error: 'Roaming is disabled', code: 'ROAMING_DISABLED' });
    }
  });

  // Block PnC certificate routes when PnC is disabled (allow settings)
  app.addHook('onRequest', async (request, reply) => {
    const url = routePath(request);
    if (!url.startsWith('/v1/pnc/')) return;
    if (url.startsWith('/v1/pnc/settings')) return;
    const enabled = await isPncEnabled();
    if (!enabled) {
      await reply.status(403).send({ error: 'Plug & Charge is disabled', code: 'PNC_DISABLED' });
    }
  });

  // Block reservation routes when Reservation feature is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = routePath(request);
    if (
      !url.startsWith('/v1/reservations') &&
      !url.startsWith('/v1/portal/reservations') &&
      !url.startsWith('/v1/fleet-reservations')
    )
      return;
    // Fleet reservation creation under /v1/fleets/:id/reservations is also guarded
    // by assertReservationsAllowed per-slot in the handler
    const enabled = await isReservationEnabled();
    if (!enabled) {
      await reply
        .status(403)
        .send({ error: 'Reservations are disabled', code: 'RESERVATION_DISABLED' });
    }
  });

  // Block support routes when Support feature is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = routePath(request);
    if (!url.startsWith('/v1/support-cases') && !url.startsWith('/v1/portal/support-cases')) return;
    const enabled = await isSupportEnabled();
    if (!enabled) {
      await reply.status(403).send({ error: 'Support is disabled', code: 'SUPPORT_DISABLED' });
    }
  });

  // Block fleet routes when Fleet feature is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = routePath(request);
    if (!url.startsWith('/v1/fleets') && !url.startsWith('/v1/fleet-reservations')) return;
    const enabled = await isFleetEnabled();
    if (!enabled) {
      await reply.status(403).send({ error: 'Fleet is disabled', code: 'FLEET_DISABLED' });
    }
  });

  // Block guest charging routes when Guest Charging is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = routePath(request);
    if (!url.startsWith('/v1/portal/guest/')) return;
    const enabled = await isGuestChargingEnabled();
    if (!enabled) {
      await reply
        .status(403)
        .send({ error: 'Guest charging is disabled', code: 'GUEST_CHARGING_DISABLED' });
    }
  });

  // CSRF validation for portal mutating requests
  registerPortalCsrf(app);

  // CSRF validation for CSMS cookie-authenticated mutating requests
  const CSMS_CSRF_SKIP_PATHS = new Set([
    '/v1/auth/login',
    '/v1/auth/refresh',
    '/v1/auth/force-change-password',
    '/v1/auth/mfa/verify',
    '/v1/auth/mfa/resend',
    '/v1/auth/webauthn/options',
    '/v1/auth/webauthn/verify',
    '/v1/auth/passkey/options',
    '/v1/auth/passkey/verify',
    '/v1/auth/forgot-password',
    '/v1/auth/reset-password',
    '/v1/health',
  ]);

  app.addHook('onRequest', async (request, reply) => {
    const url = routePath(request);
    // Only apply to /v1/ routes that are NOT portal routes
    if (!url.startsWith('/v1/')) return;
    if (url.startsWith('/v1/portal/')) return;
    if (CSRF_SKIP_METHODS.has(request.method)) return;
    if (CSMS_CSRF_SKIP_PATHS.has(url)) {
      await refuseCrossSiteSignIn(request, reply, url);
      return;
    }

    // CSRF only required when authenticating via cookie (no Authorization header)
    const authHeader = request.headers['authorization'];
    if (authHeader != null && authHeader !== '') return;

    // If using cookie auth, validate CSRF
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const csmsToken = request.cookies?.['csms_token'];
    if (csmsToken == null || csmsToken === '') return; // Not cookie auth

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const cookieCsrf = request.cookies?.['csms_csrf'];
    const headerCsrf = request.headers['x-csrf-token'];
    if (
      cookieCsrf == null ||
      headerCsrf == null ||
      typeof headerCsrf !== 'string' ||
      cookieCsrf === '' ||
      !csrfTokensMatch(cookieCsrf, headerCsrf)
    ) {
      await reply.status(403).send({ error: 'Invalid CSRF token', code: 'CSRF_INVALID' });
    }
  });

  // Block unverified portal drivers from accessing protected routes
  const VERIFY_EXEMPT_PREFIXES = ['/v1/portal/auth/', '/v1/portal/guest/'];
  const VERIFY_EXEMPT_PATHS = new Set(['/v1/portal/driver/notification-preferences']);

  app.addHook('preHandler', async (request, reply) => {
    const url = routePath(request);
    if (!url.startsWith('/v1/portal/')) return;
    if (VERIFY_EXEMPT_PREFIXES.some((p) => url.startsWith(p))) return;
    if (VERIFY_EXEMPT_PATHS.has(url)) return;

    const user = request.user as { type?: string; driverId?: string } | undefined;
    if (user?.type !== 'driver' || user.driverId == null) return;

    const [driver] = await db
      .select({
        emailVerified: drivers.emailVerified,
        registrationSource: drivers.registrationSource,
      })
      .from(drivers)
      .where(eq(drivers.id, user.driverId));

    if (driver == null) return;
    if (driver.registrationSource !== 'portal') return;
    if (!driver.emailVerified) {
      await reply.status(403).send({ error: 'Email not verified', code: 'EMAIL_NOT_VERIFIED' });
    }
  });

  // Access log: record all API requests
  registerApiAccessLog(app);

  return app;
}
