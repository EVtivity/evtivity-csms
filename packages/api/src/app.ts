// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { AppError } from '@evtivity/lib';
import {
  db,
  isRoamingEnabled,
  isPncEnabled,
  isReservationEnabled,
  isSupportEnabled,
  isFleetEnabled,
  isGuestChargingEnabled,
} from '@evtivity/database';
import { accessLogs, drivers } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import { registerCors } from './plugins/cors.js';
import { registerHelmet } from './plugins/helmet.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerAuth } from './plugins/auth.js';
import { config } from './lib/config.js';
import { registerOpenApi } from './plugins/openapi.js';
import { healthRoutes } from './routes/health.js';
import { siteRoutes } from './routes/sites.js';
import { stationRoutes } from './routes/stations.js';
import { sessionRoutes } from './routes/sessions.js';
import { userRoutes } from './routes/users.js';
import { driverRoutes } from './routes/drivers.js';
import { pricingRoutes } from './routes/pricing.js';
import { holidayRoutes } from './routes/holidays.js';
import { ocppCommandRoutes } from './routes/ocpp-commands.js';
import { ocppSchemaRoutes } from './routes/ocpp-schemas.js';
import { transactionRoutes } from './routes/transactions.js';
import { fleetRoutes } from './routes/fleets.js';
import { tokenRoutes } from './routes/tokens.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { settingsRoutes } from './routes/settings.js';
import { paymentRoutes } from './routes/payments.js';
import { eventStreamRoutes } from './routes/events.js';
import { loadManagementRoutes } from './routes/load-management.js';
import { notificationRoutes } from './routes/notifications.js';
import { portalAuthRoutes } from './routes/portal/auth.js';
import { portalDriverRoutes } from './routes/portal/driver.js';
import { portalPaymentRoutes } from './routes/portal/payments.js';
import { portalSessionRoutes } from './routes/portal/sessions.js';
import { portalChargerRoutes } from './routes/portal/charger.js';
import { portalGuestRoutes } from './routes/portal/guest.js';
import { reservationRoutes } from './routes/reservations.js';
import { accessLogRoutes } from './routes/access-logs.js';
import { displayMessageRoutes } from './routes/display-messages.js';
import { reportRoutes } from './routes/reports.js';
import { neviRoutes } from './routes/nevi.js';
import { webhookRoutes } from './routes/webhooks.js';
import { invoiceRoutes } from './routes/invoices.js';
import { supportCaseRoutes } from './routes/support-cases.js';
import { portalSupportCaseRoutes } from './routes/portal/support-cases.js';
import { portalVehicleRoutes } from './routes/portal/vehicles.js';
import { portalTokenRoutes } from './routes/portal/tokens.js';
import { portalNotificationRoutes } from './routes/portal/notifications.js';
import { portalRoamingChargerRoutes } from './routes/portal/roaming-chargers.js';
import { portalEventRoutes } from './routes/portal/events.js';
import { portalStationEventRoutes } from './routes/portal/station-events.js';
import { portalFavoriteRoutes } from './routes/portal/favorites.js';
import { ocpiPartnerRoutes } from './routes/ocpi-partners.js';
import { ocpiLocationRoutes } from './routes/ocpi-locations.js';
import { ocpiSessionRoutes } from './routes/ocpi-sessions.js';
import { ocpiCdrRoutes } from './routes/ocpi-cdrs.js';
import { ocpiTariffRoutes } from './routes/ocpi-tariffs.js';
import { pncSettingsRoutes } from './routes/pnc-settings.js';
import { pncCertificateRoutes } from './routes/pnc-certificates.js';
import { securitySettingsRoutes } from './routes/security-settings.js';
import { securityPublicRoutes } from './routes/security-public.js';
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
import { fleetReservationRoutes } from './routes/fleet-reservations.js';
import { cssRoutes } from './routes/css.js';
import { smartChargingRoutes } from './routes/smart-charging.js';
import { panelRoutes } from './routes/panels.js';
import { circuitRoutes } from './routes/circuits.js';
import { unmanagedLoadRoutes } from './routes/unmanaged-loads.js';
import { assistantRoutes } from './routes/assistant.js';
import { octtRoutes } from './routes/octt.js';

function csrfTokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function buildApp(opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  // Default body size limit: 1 MB. Individual routes can override with
  // route-level bodyLimit for endpoints that accept larger payloads
  // (e.g., certificate PEM uploads, bulk imports).
  const app = Fastify({ bodyLimit: 1_048_576, ...opts });

  // Plugins
  await app.register(cookie, {
    secret: config.JWT_SECRET,
  });
  await app.register(formbody);
  await registerCors(app);
  await registerHelmet(app);
  await registerRateLimit(app);
  await registerAuth(app);
  await registerOpenApi(app);

  // Error handler
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    const fastifyError = error as { statusCode?: number; message?: string };
    if (fastifyError.statusCode != null && fastifyError.statusCode < 500) {
      void reply
        .status(fastifyError.statusCode)
        .send({ error: fastifyError.message, code: 'VALIDATION_ERROR' });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  });

  // Routes
  await app.register(healthRoutes);

  // All versioned routes under /v1
  await app.register(
    async function v1Routes(v1) {
      await v1.register(siteRoutes);
      await v1.register(stationRoutes);
      await v1.register(sessionRoutes);
      await v1.register(userRoutes);
      await v1.register(driverRoutes);
      await v1.register(pricingRoutes);
      await v1.register(holidayRoutes);
      await v1.register(ocppCommandRoutes);
      await v1.register(ocppSchemaRoutes);
      await v1.register(transactionRoutes);
      await v1.register(fleetRoutes);
      await v1.register(tokenRoutes);
      await v1.register(dashboardRoutes);
      await v1.register(settingsRoutes);
      await v1.register(paymentRoutes);
      await v1.register(eventStreamRoutes);
      await v1.register(loadManagementRoutes);
      await v1.register(notificationRoutes);
      await v1.register(reservationRoutes);
      await v1.register(portalAuthRoutes);
      await v1.register(portalDriverRoutes);
      await v1.register(portalPaymentRoutes);
      await v1.register(portalSessionRoutes);
      await v1.register(portalChargerRoutes);
      await v1.register(portalGuestRoutes);
      await v1.register(accessLogRoutes);
      await v1.register(displayMessageRoutes);
      await v1.register(reportRoutes);
      await v1.register(neviRoutes);
      await v1.register(webhookRoutes);
      await v1.register(invoiceRoutes);
      await v1.register(supportCaseRoutes);
      await v1.register(portalVehicleRoutes);
      await v1.register(portalTokenRoutes);
      await v1.register(portalNotificationRoutes);
      await v1.register(portalSupportCaseRoutes);
      await v1.register(portalRoamingChargerRoutes);
      await v1.register(portalEventRoutes);
      await v1.register(portalStationEventRoutes);
      await v1.register(portalFavoriteRoutes);
      await v1.register(ocpiPartnerRoutes);
      await v1.register(ocpiLocationRoutes);
      await v1.register(ocpiSessionRoutes);
      await v1.register(ocpiCdrRoutes);
      await v1.register(ocpiTariffRoutes);
      await v1.register(pncSettingsRoutes);
      await v1.register(pncCertificateRoutes);
      await v1.register(securitySettingsRoutes);
      await v1.register(securityPublicRoutes);
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
      await v1.register(fleetReservationRoutes);
      await v1.register(cssRoutes);
      await v1.register(smartChargingRoutes);
      await v1.register(panelRoutes);
      await v1.register(circuitRoutes);
      await v1.register(unmanagedLoadRoutes);
      await v1.register(assistantRoutes);
      await v1.register(octtRoutes);
    },
    { prefix: '/v1' },
  );

  // Block OCPI management and portal roaming routes when roaming is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/ocpi/') && !url.startsWith('/v1/portal/chargers/roaming')) return;
    const enabled = await isRoamingEnabled();
    if (!enabled) {
      await reply.status(403).send({ error: 'Roaming is disabled', code: 'ROAMING_DISABLED' });
    }
  });

  // Block PnC certificate routes when PnC is disabled (allow settings)
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/pnc/')) return;
    if (url.startsWith('/v1/pnc/settings')) return;
    const enabled = await isPncEnabled();
    if (!enabled) {
      await reply.status(403).send({ error: 'Plug & Charge is disabled', code: 'PNC_DISABLED' });
    }
  });

  // Block reservation routes when Reservation feature is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
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
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/support-cases') && !url.startsWith('/v1/portal/support-cases')) return;
    const enabled = await isSupportEnabled();
    if (!enabled) {
      await reply.status(403).send({ error: 'Support is disabled', code: 'SUPPORT_DISABLED' });
    }
  });

  // Block fleet routes when Fleet feature is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/fleets') && !url.startsWith('/v1/fleet-reservations')) return;
    const enabled = await isFleetEnabled();
    if (!enabled) {
      await reply.status(403).send({ error: 'Fleet is disabled', code: 'FLEET_DISABLED' });
    }
  });

  // Block guest charging routes when Guest Charging is disabled
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/portal/guest/')) return;
    const enabled = await isGuestChargingEnabled();
    if (!enabled) {
      await reply
        .status(403)
        .send({ error: 'Guest charging is disabled', code: 'GUEST_CHARGING_DISABLED' });
    }
  });

  // CSRF validation for portal mutating requests
  const CSRF_SKIP_PATHS = new Set([
    '/v1/portal/auth/login',
    '/v1/portal/auth/register',
    '/v1/portal/auth/refresh',
    '/v1/portal/auth/verify-email',
    '/v1/portal/auth/forgot-password',
    '/v1/portal/auth/reset-password',
    '/v1/portal/auth/mfa/verify',
    '/v1/portal/auth/mfa/resend',
  ]);
  const CSRF_SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    if (!url.startsWith('/v1/portal/')) return;
    if (CSRF_SKIP_METHODS.has(request.method)) return;
    if (CSRF_SKIP_PATHS.has(url)) return;
    if (url.startsWith('/v1/portal/guest/')) return;

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

  // CSRF validation for CSMS cookie-authenticated mutating requests
  const CSMS_CSRF_SKIP_PATHS = new Set([
    '/v1/auth/login',
    '/v1/auth/refresh',
    '/v1/auth/force-change-password',
    '/v1/auth/mfa/verify',
    '/v1/auth/mfa/resend',
    '/v1/auth/forgot-password',
    '/v1/auth/reset-password',
    '/v1/health',
  ]);

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? request.url;
    // Only apply to /v1/ routes that are NOT portal routes
    if (!url.startsWith('/v1/')) return;
    if (url.startsWith('/v1/portal/')) return;
    if (CSRF_SKIP_METHODS.has(request.method)) return;
    if (CSMS_CSRF_SKIP_PATHS.has(url)) return;

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
    const url = request.url.split('?')[0] ?? request.url;
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
  const SKIP_LOG_PATHS = new Set([
    '/health',
    '/v1/events',
    '/v1/access-logs',
    '/v1/portal/access-logs',
  ]);

  app.addHook('onResponse', async (request, reply) => {
    try {
      const url = request.url;
      if (!url.startsWith('/v1/')) return;
      const pathOnly = url.split('?')[0] ?? url;
      if (SKIP_LOG_PATHS.has(pathOnly)) return;

      let userId: string | null = null;
      let authType: string = 'anonymous';
      let apiKeyName: string | null = null;
      try {
        const payload = request.user as unknown as Record<string, unknown> | undefined;
        if (payload != null && typeof payload['userId'] === 'string') {
          userId = payload['userId'];
          if (payload['isApiKey'] === true) {
            authType = 'api_key';
            apiKeyName = typeof payload['apiKeyName'] === 'string' ? payload['apiKeyName'] : null;
          } else {
            authType = 'session';
          }
        }
      } catch {
        // Unauthenticated request
      }

      const hasBody = request.method !== 'GET' && request.method !== 'DELETE';
      let metadata: Record<string, unknown> | undefined;
      if (hasBody && request.body != null && typeof request.body === 'object') {
        const SENSITIVE_KEYS = new Set([
          'password',
          'currentPassword',
          'newPassword',
          'confirmPassword',
          'token',
          'secret',
          'secretKey',
          'recaptchaToken',
          'code',
          'certificate',
        ]);
        const raw = request.body as Record<string, unknown>;
        const sanitized: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(raw)) {
          sanitized[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : v;
        }
        metadata = sanitized;
      }

      await db.insert(accessLogs).values({
        userId,
        action: `${request.method} ${pathOnly}`,
        category: 'api',
        authType,
        apiKeyName,
        method: request.method,
        path: pathOnly,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        remoteAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        metadata,
      });
    } catch {
      // Best-effort logging: do not break responses
    }
  });

  return app;
}
