// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  API_PORT: z.coerce.number().int().positive(),
  API_HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(1).default('dev-secret-change-in-production'),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(3000),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AUTH_RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  METRICS_PORT: z.coerce.number().int().positive().default(9091),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Required: encryption key for settings storing secrets (Stripe, S3,
  // SSO, reCAPTCHA, PnC). Defaulting to empty meant the API started fine
  // and only failed at runtime when a route tried to decrypt; per the
  // fail-loud-at-critical-edges rule, refuse to start when missing.
  SETTINGS_ENCRYPTION_KEY: z.string().min(1),
  CSMS_URL: z.string().default('http://localhost:7100'),
  PORTAL_URL: z.string().default('http://localhost:7101'),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  COOKIE_DOMAIN: z.string().optional(),
  // Public wss:// address stations use for security profiles 2 and 3, without
  // the station identity. Needed to move a connected 2.1 station from plain
  // WebSocket to TLS (OCPP 2.1 A05); unset disables that upgrade.
  OCPP_STATION_TLS_URL: z.string().url().optional(),
});

export type ApiConfig = z.infer<typeof schema>;
export const config = schema.parse(process.env);
