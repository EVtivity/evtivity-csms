// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authorize } from '../middleware/rbac.js';
import { itemResponse } from '../lib/response-schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readVersion(): string {
  for (const candidate of [
    resolve(__dirname, '../../package.json'),
    resolve(__dirname, '../package.json'),
    resolve(__dirname, '../../../package.json'),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version != null && pkg.version !== '') return pkg.version;
    } catch {
      /* try next candidate */
    }
  }
  return process.env['npm_package_version'] ?? 'unknown';
}

const APP_VERSION = readVersion();

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

const systemInfoResponse = z
  .object({
    version: z.string(),
    nodeEnv: z.string(),
    logLevel: z.string(),
    network: z
      .object({
        bindIp: z.string().nullable(),
        apiPort: z.string(),
        apiHost: z.string(),
        ocppPort: z.string(),
        ocppHost: z.string(),
        ocppHealthPort: z.string(),
        ocppTlsPort: z.string().nullable(),
        ocppTlsEnabled: z.boolean(),
        ocpiPort: z.string().nullable(),
        ocpiHost: z.string().nullable(),
        metricsPort: z.string(),
        csmsUrl: z.string().nullable(),
        portalUrl: z.string().nullable(),
        cookieDomain: z.string().nullable(),
        corsOrigin: z.string(),
      })
      .passthrough(),
    rateLimits: z
      .object({
        rateLimitMax: z.string(),
        rateLimitWindow: z.string(),
        authRateLimitMax: z.string(),
        ocppMaxConnectionsPerIp: z.string().nullable(),
        ocppMaxMessagesPerIpPerSecond: z.string().nullable(),
      })
      .passthrough(),
    ocpp: z
      .object({
        instanceId: z.string().nullable(),
        registrationPolicy: z.string(),
      })
      .passthrough(),
    ocpi: z
      .object({
        baseUrl: z.string().nullable(),
        countryCode: z.string(),
        partyId: z.string(),
        businessName: z.string().nullable(),
      })
      .passthrough(),
    simulator: z
      .object({
        mode: z.string(),
        actionIntervalMs: z.string().nullable(),
        stationLimit: z.string().nullable(),
      })
      .passthrough(),
    seed: z
      .object({
        seedDemo: z.string(),
      })
      .passthrough(),
    secrets: z
      .object({
        jwtConfigured: z.boolean(),
        settingsEncryptionConfigured: z.boolean(),
        stripeConfigured: z.boolean(),
        smtpConfigured: z.boolean(),
        twilioConfigured: z.boolean(),
        s3Configured: z.boolean(),
        recaptchaConfigured: z.boolean(),
        hubjectConfigured: z.boolean(),
        googleMapsConfigured: z.boolean(),
      })
      .passthrough(),
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
    () => ({
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
        stripeConfigured: envHasValue('STRIPE_SECRET_KEY'),
        smtpConfigured: envHasValue('SMTP_HOST'),
        twilioConfigured: envHasValue('TWILIO_ACCOUNT_SID'),
        s3Configured: envHasValue('S3_BUCKET'),
        recaptchaConfigured: envHasValue('RECAPTCHA_SECRET_KEY'),
        hubjectConfigured: envHasValue('HUBJECT_TOKEN'),
        googleMapsConfigured: envHasValue('GOOGLE_MAPS_API_KEY'),
      },
    }),
  );
}
