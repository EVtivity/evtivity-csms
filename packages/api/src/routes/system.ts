// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  client,
  cssStations,
  db,
  effectiveDataPlanSql,
  getOcppFleetHealth,
  isOperatorStation,
  settings,
  sites,
  chargingStations,
} from '@evtivity/database';
import { WEBHOOK_SIGNING_SECRET_KEY } from '@evtivity/lib';
import { authorize } from '../middleware/rbac.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { isWeakJwtSecret, isWeakSettingsEncryptionKey } from '@evtivity/lib/deployment-secrets';
import { APP_VERSION } from '../lib/app-version.js';
import { activePaymentProvider } from '../lib/payments.js';
import { config } from '../lib/config.js';
import { storedSecretDecrypts } from '../lib/settings-crypto.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Whether the API counts its rate limits in Redis, shared by every replica (buildApp). */
    sharedRateLimit: boolean;
  }
}

// Values only Docker Compose or the other services set: read from the
// environment, as no API config field holds them.
function envStr(key: string): string {
  return process.env[key] ?? '';
}

function envOptional(key: string): string | null {
  const value = process.env[key];
  return value != null && value !== '' ? value : null;
}

function envHasValue(key: string): boolean {
  const value = process.env[key];
  return value != null && value !== '';
}

const INTEGRATION_SETTING_KEYS = [
  'payments.provider',
  'stripe.secretKeyEnc',
  'adyen.apiKeyEnc',
  'smtp.host',
  'twilio.accountSid',
  's3.bucket',
  'security.recaptcha.secretKeyEnc',
  'pnc.hubject.baseUrl',
  'googleMaps.apiKeyEnc',
  'ocpp.registrationPolicy',
  'sim.hologram.enabled',
  'sim.hologram.orgId',
  'sim.hologram.apiKeyEnc',
  'sim.1nce.enabled',
  'sim.1nce.clientId',
  'sim.1nce.clientSecretEnc',
  'sim.sessions.fetchDays',
  'sim.stationSignal.enabled',
  WEBHOOK_SIGNING_SECRET_KEY,
] as const;

async function loadIntegrationSettings(): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...INTEGRATION_SETTING_KEYS]));
  return new Map(rows.map((row) => [row.key, row.value]));
}

function settingHasValue(map: Map<string, unknown>, key: string): boolean {
  const value = map.get(key);
  return typeof value === 'string' && value !== '';
}

function settingBoolean(map: Map<string, unknown>, key: string): boolean {
  const value = map.get(key);
  return value === true || value === 'true';
}

function settingNumber(map: Map<string, unknown>, key: string): number | null {
  const value = map.get(key);
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Accepted operator stations per effective data plan, and sites per explicit plan. */
async function loadDataPlanCounts(): Promise<{
  stations: { wifiOrWired: number; cellular: number };
  sites: { wifiOrWired: number; cellular: number };
}> {
  const [stationRows, siteRows] = await Promise.all([
    db
      .select({ plan: effectiveDataPlanSql, count: sql<number>`count(*)::int` })
      .from(chargingStations)
      .where(and(isOperatorStation(), eq(chargingStations.onboardingStatus, 'accepted')))
      .groupBy(sql`1`),
    db
      .select({ plan: sites.dataPlan, count: sql<number>`count(*)::int` })
      .from(sites)
      .where(isNotNull(sites.dataPlan))
      .groupBy(sites.dataPlan),
  ]);
  const tally = (rows: Array<{ plan: string | null; count: number }>) => ({
    wifiOrWired: rows.find((r) => r.plan === 'wifi_or_wired')?.count ?? 0,
    cellular: rows.find((r) => r.plan === 'cellular')?.count ?? 0,
  });
  return { stations: tally(stationRows), sites: tally(siteRows) };
}

async function countSimulatorStations(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(cssStations);
  return row?.count ?? 0;
}

const ocppProcessConfigSchema = z
  .object({
    version: z.string().describe('Release version of the OCPP process'),
    wsCompression: z.boolean().describe('WebSocket permessage-deflate on (OCPP_WS_COMPRESSION)'),
    tlsEnabled: z.boolean().describe('Whether the TLS (wss) listener runs'),
    tlsPort: z.number().nullable().describe('TLS listener port, when it runs'),
    clientCaConfigured: z
      .boolean()
      .describe('Whether a CA for security profile 3 client certificates is set (OCPP_TLS_CA)'),
    maxConnectionsPerIp: z.number().describe('OCPP_MAX_CONNECTIONS_PER_IP'),
    maxMessagesPerIpPerSecond: z.number().describe('OCPP_MAX_MESSAGES_PER_IP_PER_SECOND'),
    maxPendingAuthPerIp: z.number().describe('OCPP_MAX_PENDING_AUTH_PER_IP'),
    trustedProxiesConfigured: z
      .boolean()
      .describe('Whether OCPP_TRUSTED_PROXY_CIDRS lists any proxy'),
  })
  .loose();

const dataPlanCounts = z
  .object({
    wifiOrWired: z.number().describe('Count on the Wi-Fi or wired plan'),
    cellular: z.number().describe('Count on the cellular plan'),
  })
  .loose();

const systemInfoResponse = z
  .object({
    version: z.string().describe('Application version (from package.json)'),
    nodeEnv: z.string().describe('Node.js environment (development, production, etc.)'),
    logLevel: z.string().describe('Pino log level in use'),
    network: z
      .object({
        bindIp: z
          .string()
          .nullable()
          .describe(
            'Docker Compose host address the user-facing ports bind to (BIND_IP); null outside Docker Compose',
          ),
        apiPort: z.string().describe('REST API listening port'),
        apiHost: z.string().describe('REST API listening host'),
        ocppStationTlsUrl: z
          .string()
          .nullable()
          .describe('Public wss:// address stations use for security profiles 2 and 3'),
        ocpiPort: z.string().nullable().describe('OCPI server port'),
        ocpiHost: z.string().nullable().describe('OCPI server host'),
        metricsPort: z.string().describe('Prometheus metrics port'),
        csmsUrl: z.string().nullable().describe('Public URL of the CSMS dashboard'),
        portalUrl: z.string().nullable().describe('Public URL of the driver portal'),
        cookieDomain: z.string().nullable().describe('Cookie domain used for auth cookies'),
        corsOrigin: z.string().describe('Configured CORS allowed origin(s)'),
      })
      .loose()
      .describe('Network listener and URL configuration'),
    rateLimits: z
      .object({
        rateLimitMax: z.string().describe('Default request rate limit per window'),
        rateLimitWindow: z.string().describe('Default rate limit window duration'),
        authRateLimitMax: z.string().describe('Login rate limit per window'),
        authRateLimitWindow: z.string().describe('Login rate limit window duration'),
      })
      .loose()
      .describe('Rate-limit configuration of the API'),
    security: z
      .object({
        trustProxyConfigured: z
          .boolean()
          .describe('Whether TRUST_PROXY lists the proxies in front of the API'),
        webauthnRpId: z
          .string()
          .nullable()
          .describe('WebAuthn relying party ID (WEBAUTHN_RP_ID); null uses the CSMS host'),
        sharedRateLimit: z
          .boolean()
          .describe('Whether the API counts rate limits in Redis, shared by every replica'),
      })
      .loose()
      .describe('API security configuration (no secret values)'),
    ocpp: z
      .object({
        registrationPolicy: z
          .string()
          .describe('Station registration policy setting (approval-required or open)'),
      })
      .loose()
      .describe('OCPP configuration'),
    ocppProcesses: z
      .array(
        z
          .object({
            instanceId: z.string().describe('Process instance ID (pod or task)'),
            connectedStations: z.number().describe('Stations connected to the process'),
            serverStartedAt: z.coerce.date().describe('When the process started'),
            updatedAt: z.coerce.date().describe('When the process last wrote its health row'),
            config: ocppProcessConfigSchema
              .nullable()
              .describe('Settings the process runs with; null from an older process'),
          })
          .loose(),
      )
      .describe('Running OCPP processes and the settings each reports'),
    ocpi: z
      .object({
        baseUrl: z.string().nullable().describe('Public OCPI base URL exposed to partners'),
        countryCode: z.string().describe('OCPI country code (ISO 3166-1)'),
        partyId: z.string().describe('OCPI party identifier'),
        businessName: z.string().nullable().describe('Business name advertised over OCPI'),
      })
      .loose()
      .describe('OCPI configuration'),
    simulator: z
      .object({
        mode: z.string().describe('Charging station simulator mode (standby, chaos, etc.)'),
        actionIntervalMs: z
          .string()
          .nullable()
          .describe('Action interval in milliseconds when running in chaos mode'),
        stationLimit: z.string().nullable().describe('Maximum number of simulated stations'),
        stationCount: z.number().describe('Simulator stations stored (css_stations)'),
      })
      .loose()
      .describe('Charging station simulator configuration'),
    seed: z
      .object({
        seedDemo: z.string().describe('Whether demo data seeding is enabled'),
      })
      .loose()
      .describe('Database seeding configuration'),
    payments: z
      .object({
        provider: z
          .string()
          .describe('Provider selected for new payments (payments.provider), or none'),
        configured: z
          .boolean()
          .describe('The selected provider is available in this process and has its credentials'),
      })
      .loose()
      .describe('Payment provider status'),
    simProviders: z
      .object({
        hologram: z
          .object({
            enabled: z.boolean().describe('sim.hologram.enabled'),
            configured: z
              .boolean()
              .describe('Whether the Hologram organization id and API key are set'),
          })
          .loose(),
        '1nce': z
          .object({
            enabled: z.boolean().describe('sim.1nce.enabled'),
            configured: z
              .boolean()
              .describe('Whether the 1NCE client id and client secret are set'),
          })
          .loose(),
        sessionsFetchDays: z.number().nullable().describe('sim.sessions.fetchDays'),
        stationSignalEnabled: z.boolean().describe('sim.stationSignal.enabled'),
      })
      .loose()
      .describe('SIM provider settings (no secret values)'),
    dataPlans: z
      .object({
        stations: dataPlanCounts.describe('Accepted operator stations per effective data plan'),
        sites: dataPlanCounts.describe('Sites with an explicit data plan'),
      })
      .loose()
      .describe('Station data plans'),
    secrets: z
      .object({
        jwtConfigured: z
          .boolean()
          .describe(
            'Whether JWT_SECRET is at least 32 characters and not a published example value',
          ),
        settingsEncryptionConfigured: z
          .boolean()
          .describe(
            'Whether SETTINGS_ENCRYPTION_KEY is at least 32 characters and not a published example value',
          ),
        stripeConfigured: z
          .boolean()
          .describe('Whether the Stripe secret key is configured in settings'),
        adyenConfigured: z
          .boolean()
          .describe('Whether the Adyen API key is configured in settings'),
        smtpConfigured: z
          .boolean()
          .describe('Whether an SMTP host is configured (settings or SMTP_HOST override)'),
        twilioConfigured: z
          .boolean()
          .describe('Whether the Twilio account SID is configured in settings'),
        s3Configured: z.boolean().describe('Whether an S3 bucket is configured in settings'),
        recaptchaConfigured: z
          .boolean()
          .describe('Whether the reCAPTCHA secret key is configured in settings'),
        hubjectConfigured: z
          .boolean()
          .describe('Whether the Hubject base URL is configured in settings'),
        googleMapsConfigured: z
          .boolean()
          .describe('Whether the Google Maps API key is configured in settings'),
        webhookSigningConfigured: z
          .boolean()
          .describe('Whether a webhook signing secret is stored and decrypts'),
        simHologramConfigured: z
          .boolean()
          .describe('Whether the Hologram API key is stored and decrypts'),
        simOneNceConfigured: z
          .boolean()
          .describe('Whether the 1NCE client secret is stored and decrypts'),
      })
      .loose()
      .describe('Configured-status flags for secrets (no secret values are returned)'),
  })
  .loose();

export function systemRoutes(app: FastifyInstance): void {
  app.get(
    '/system/info',
    {
      onRequest: [authorize('settings.system:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Runtime version and environment configuration (no secret values)',
        operationId: 'getSystemInfo',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(systemInfoResponse),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      // Company-wide configuration (payment provider, integrations, URLs,
      // CORS, rate limits): all-site access only (features/site-access-control.md).
      if (
        !(await requireAllSiteAccess(request, reply, {
          error: 'Setting not found',
          code: 'SETTING_NOT_FOUND',
        }))
      )
        return;
      const [integration, fleet, dataPlans, simulatorStations] = await Promise.all([
        loadIntegrationSettings(),
        getOcppFleetHealth(client),
        loadDataPlanCounts(),
        countSimulatorStations(),
      ]);
      const selected = integration.get('payments.provider');
      const policy = integration.get('ocpp.registrationPolicy');
      const hologramConfigured =
        settingHasValue(integration, 'sim.hologram.orgId') &&
        storedSecretDecrypts('sim.hologram.apiKeyEnc', integration.get('sim.hologram.apiKeyEnc'));
      const oneNceConfigured =
        settingHasValue(integration, 'sim.1nce.clientId') &&
        storedSecretDecrypts(
          'sim.1nce.clientSecretEnc',
          integration.get('sim.1nce.clientSecretEnc'),
        );
      return {
        version: APP_VERSION,
        nodeEnv: config.NODE_ENV,
        logLevel: config.LOG_LEVEL,
        network: {
          bindIp: envOptional('BIND_IP'),
          apiPort: String(config.API_PORT),
          apiHost: config.API_HOST,
          ocppStationTlsUrl: config.OCPP_STATION_TLS_URL ?? null,
          ocpiPort: envOptional('OCPI_PORT'),
          ocpiHost: envOptional('OCPI_HOST'),
          metricsPort: String(config.METRICS_PORT),
          csmsUrl: config.CSMS_URL,
          portalUrl: config.PORTAL_URL,
          cookieDomain:
            config.COOKIE_DOMAIN != null && config.COOKIE_DOMAIN !== ''
              ? config.COOKIE_DOMAIN
              : null,
          corsOrigin: config.CORS_ORIGIN,
        },
        rateLimits: {
          rateLimitMax: String(config.RATE_LIMIT_MAX),
          rateLimitWindow: config.RATE_LIMIT_WINDOW,
          authRateLimitMax: String(config.AUTH_RATE_LIMIT_MAX),
          authRateLimitWindow: config.AUTH_RATE_LIMIT_WINDOW,
        },
        security: {
          trustProxyConfigured: config.TRUST_PROXY !== false,
          webauthnRpId: config.WEBAUTHN_RP_ID ?? null,
          sharedRateLimit: app.hasDecorator('sharedRateLimit') && app.sharedRateLimit,
        },
        ocpp: {
          registrationPolicy:
            typeof policy === 'string' && policy !== '' ? policy : 'approval-required',
        },
        ocppProcesses: fleet.instances.map((instance) => ({
          instanceId: instance.instanceId,
          connectedStations: instance.connectedStations,
          serverStartedAt: instance.serverStartedAt,
          updatedAt: instance.updatedAt,
          config: instance.config ?? null,
        })),
        ocpi: {
          baseUrl: envOptional('OCPI_BASE_URL'),
          countryCode: envStr('OCPI_COUNTRY_CODE') || 'US',
          partyId: envStr('OCPI_PARTY_ID') || 'EVT',
          businessName: envOptional('OCPI_BUSINESS_NAME'),
        },
        simulator: {
          mode: envStr('CSS_MODE') || 'standby',
          actionIntervalMs: envOptional('CSS_ACTION_INTERVAL_MS'),
          stationLimit: envOptional('CSS_STATION_LIMIT'),
          stationCount: simulatorStations,
        },
        seed: {
          seedDemo: envStr('SEED_DEMO') || 'false',
        },
        payments: {
          provider: typeof selected === 'string' && selected !== '' ? selected : 'none',
          configured: (await activePaymentProvider(request.log)) != null,
        },
        simProviders: {
          hologram: {
            enabled: settingBoolean(integration, 'sim.hologram.enabled'),
            configured: hologramConfigured,
          },
          '1nce': {
            enabled: settingBoolean(integration, 'sim.1nce.enabled'),
            configured: oneNceConfigured,
          },
          sessionsFetchDays: settingNumber(integration, 'sim.sessions.fetchDays'),
          stationSignalEnabled: settingBoolean(integration, 'sim.stationSignal.enabled'),
        },
        dataPlans,
        secrets: {
          // A short or published value (Compose, .env.example) is not configured.
          jwtConfigured: !isWeakJwtSecret(config.JWT_SECRET),
          settingsEncryptionConfigured: !isWeakSettingsEncryptionKey(
            config.SETTINGS_ENCRYPTION_KEY,
          ),
          stripeConfigured: settingHasValue(integration, 'stripe.secretKeyEnc'),
          adyenConfigured: settingHasValue(integration, 'adyen.apiKeyEnc'),
          smtpConfigured: envHasValue('SMTP_HOST') || settingHasValue(integration, 'smtp.host'),
          twilioConfigured: settingHasValue(integration, 'twilio.accountSid'),
          s3Configured: settingHasValue(integration, 's3.bucket'),
          recaptchaConfigured: settingHasValue(integration, 'security.recaptcha.secretKeyEnc'),
          hubjectConfigured: settingHasValue(integration, 'pnc.hubject.baseUrl'),
          googleMapsConfigured: settingHasValue(integration, 'googleMaps.apiKeyEnc'),
          webhookSigningConfigured: storedSecretDecrypts(
            WEBHOOK_SIGNING_SECRET_KEY,
            integration.get(WEBHOOK_SIGNING_SECRET_KEY),
          ),
          simHologramConfigured: storedSecretDecrypts(
            'sim.hologram.apiKeyEnc',
            integration.get('sim.hologram.apiKeyEnc'),
          ),
          simOneNceConfigured: storedSecretDecrypts(
            'sim.1nce.clientSecretEnc',
            integration.get('sim.1nce.clientSecretEnc'),
          ),
        },
      };
    },
  );
}
