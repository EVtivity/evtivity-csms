// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inArray } from 'drizzle-orm';
import { db, settings } from '@evtivity/database';
import { authorize } from '../middleware/rbac.js';
import { itemResponse } from '../lib/response-schemas.js';
import { APP_VERSION } from '../lib/app-version.js';

function envStr(key: string): string {
  return process.env[key] ?? '';
}

function envOptional(key: string): string | null {
  const value = process.env[key];
  return value != null && value !== '' ? value : null;
}

function envHasValue(key: string, defaultValueIfDev?: string): boolean {
  const value = process.env[key];
  if (value == null || value === '') return false;
  if (defaultValueIfDev != null && value === defaultValueIfDev) return false;
  return true;
}

const INTEGRATION_SETTING_KEYS = [
  'stripe.secretKeyEnc',
  'smtp.host',
  'twilio.accountSid',
  's3.bucket',
  'security.recaptcha.secretKeyEnc',
  'pnc.hubject.baseUrl',
  'googleMaps.apiKeyEnc',
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

const systemInfoResponse = z
  .object({
    version: z.string().describe('Application version (from package.json)'),
    nodeEnv: z.string().describe('Node.js environment (development, production, etc.)'),
    logLevel: z.string().describe('Pino log level in use'),
    network: z
      .object({
        bindIp: z.string().nullable().describe('Bind IP override, when set'),
        apiPort: z.string().describe('REST API listening port'),
        apiHost: z.string().describe('REST API listening host'),
        ocppPort: z.string().describe('OCPP WebSocket listening port'),
        ocppHost: z.string().describe('OCPP WebSocket listening host'),
        ocppHealthPort: z.string().describe('OCPP health check port'),
        ocppTlsPort: z.string().nullable().describe('OCPP TLS port, when TLS is enabled'),
        ocppTlsEnabled: z.boolean().describe('Whether OCPP TLS (wss) is enabled'),
        ocpiPort: z.string().nullable().describe('OCPI server port'),
        ocpiHost: z.string().nullable().describe('OCPI server host'),
        metricsPort: z.string().describe('Prometheus metrics port'),
        csmsUrl: z.string().nullable().describe('Public URL of the CSMS dashboard'),
        portalUrl: z.string().nullable().describe('Public URL of the driver portal'),
        cookieDomain: z.string().nullable().describe('Cookie domain used for auth cookies'),
        corsOrigin: z.string().describe('Configured CORS allowed origin(s)'),
      })
      .passthrough()
      .describe('Network listener and URL configuration'),
    rateLimits: z
      .object({
        rateLimitMax: z.string().describe('Default request rate limit per window'),
        rateLimitWindow: z.string().describe('Default rate limit window duration'),
        authRateLimitMax: z.string().describe('Login rate limit per window'),
        ocppMaxConnectionsPerIp: z
          .string()
          .nullable()
          .describe('Maximum simultaneous OCPP connections allowed from one IP'),
        ocppMaxMessagesPerIpPerSecond: z
          .string()
          .nullable()
          .describe('Maximum OCPP messages per second from one IP'),
      })
      .passthrough()
      .describe('Rate-limit configuration'),
    ocpp: z
      .object({
        instanceId: z
          .string()
          .nullable()
          .describe('Pod identifier used by RedisConnectionRegistry for horizontal scaling'),
        registrationPolicy: z
          .string()
          .describe('Station registration policy (approval-required or auto-approve)'),
      })
      .passthrough()
      .describe('OCPP server configuration'),
    ocpi: z
      .object({
        baseUrl: z.string().nullable().describe('Public OCPI base URL exposed to partners'),
        countryCode: z.string().describe('OCPI country code (ISO 3166-1)'),
        partyId: z.string().describe('OCPI party identifier'),
        businessName: z.string().nullable().describe('Business name advertised over OCPI'),
      })
      .passthrough()
      .describe('OCPI configuration'),
    simulator: z
      .object({
        mode: z.string().describe('Charging station simulator mode (standby, chaos, etc.)'),
        actionIntervalMs: z
          .string()
          .nullable()
          .describe('Action interval in milliseconds when running in chaos mode'),
        stationLimit: z.string().nullable().describe('Maximum number of simulated stations'),
      })
      .passthrough()
      .describe('Charging station simulator configuration'),
    seed: z
      .object({
        seedDemo: z.string().describe('Whether demo data seeding is enabled'),
      })
      .passthrough()
      .describe('Database seeding configuration'),
    secrets: z
      .object({
        jwtConfigured: z.boolean().describe('Whether JWT_SECRET is set to a non-default value'),
        settingsEncryptionConfigured: z
          .boolean()
          .describe('Whether SETTINGS_ENCRYPTION_KEY is configured'),
        stripeConfigured: z
          .boolean()
          .describe('Whether the Stripe secret key is configured in settings'),
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
      })
      .passthrough()
      .describe('Configured-status flags for secrets (no secret values are returned)'),
  })
  .passthrough();

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
        response: { 200: itemResponse(systemInfoResponse) },
      },
    },
    async () => {
      const integration = await loadIntegrationSettings();
      return {
        version: APP_VERSION,
        nodeEnv: envStr('NODE_ENV') || 'development',
        logLevel: envStr('LOG_LEVEL') || 'info',
        network: {
          bindIp: envOptional('BIND_IP'),
          apiPort: envStr('API_PORT') || '7102',
          apiHost: envStr('API_HOST') || '0.0.0.0',
          ocppPort: envStr('OCPP_PORT') || '7103',
          ocppHost: envStr('OCPP_HOST') || '0.0.0.0',
          ocppHealthPort: envStr('OCPP_HEALTH_PORT') || '8081',
          ocppTlsPort: envOptional('OCPP_TLS_PORT'),
          ocppTlsEnabled: envHasValue('OCPP_TLS_CERT'),
          ocpiPort: envOptional('OCPI_PORT'),
          ocpiHost: envOptional('OCPI_HOST'),
          metricsPort: envStr('METRICS_PORT') || '9091',
          csmsUrl: envOptional('CSMS_URL'),
          portalUrl: envOptional('PORTAL_URL'),
          cookieDomain: envOptional('COOKIE_DOMAIN'),
          corsOrigin: envStr('CORS_ORIGIN') || '*',
        },
        rateLimits: {
          rateLimitMax: envStr('RATE_LIMIT_MAX') || '3000',
          rateLimitWindow: envStr('RATE_LIMIT_WINDOW') || '1 minute',
          authRateLimitMax: envStr('AUTH_RATE_LIMIT_MAX') || '30',
          ocppMaxConnectionsPerIp: envOptional('OCPP_MAX_CONNECTIONS_PER_IP'),
          ocppMaxMessagesPerIpPerSecond: envOptional('OCPP_MAX_MESSAGES_PER_IP_PER_SECOND'),
        },
        ocpp: {
          instanceId: envOptional('OCPP_INSTANCE_ID'),
          registrationPolicy: envStr('REGISTRATION_POLICY') || 'approval-required',
        },
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
        },
        seed: {
          seedDemo: envStr('SEED_DEMO') || 'false',
        },
        secrets: {
          jwtConfigured: envHasValue('JWT_SECRET', 'dev-secret-change-in-production'),
          settingsEncryptionConfigured: envHasValue('SETTINGS_ENCRYPTION_KEY'),
          stripeConfigured: settingHasValue(integration, 'stripe.secretKeyEnc'),
          smtpConfigured: envHasValue('SMTP_HOST') || settingHasValue(integration, 'smtp.host'),
          twilioConfigured: settingHasValue(integration, 'twilio.accountSid'),
          s3Configured: settingHasValue(integration, 's3.bucket'),
          recaptchaConfigured: settingHasValue(integration, 'security.recaptcha.secretKeyEnc'),
          hubjectConfigured: settingHasValue(integration, 'pnc.hubject.baseUrl'),
          googleMapsConfigured: settingHasValue(integration, 'googleMaps.apiKeyEnc'),
        },
      };
    },
  );
}
