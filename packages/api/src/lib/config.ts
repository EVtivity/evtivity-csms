// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { resolveNotificationTestSinkUrl } from '@evtivity/lib/notification-test-sink';

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
  COOKIE_DOMAIN: z.string().optional(),
  // Public wss:// address stations use for security profiles 2 and 3, without
  // the station identity. Needed to move a connected 2.1 station from plain
  // WebSocket to TLS (OCPP 2.1 A05); unset disables that upgrade.
  OCPP_STATION_TLS_URL: z.string().url().optional(),
  // Allows the simulated (test) payment provider in this process (D-T1). Default:
  // on when NODE_ENV is development (or unset) or test, off otherwise.
  PAYMENTS_ALLOW_SIMULATED: z
    .enum(['true', 'false'])
    .default(
      ['development', 'test'].includes(process.env['NODE_ENV'] ?? 'development') ? 'true' : 'false',
    )
    .transform((v) => v === 'true'),
  // Notification test sink (local development only, off by default): driver SMS
  // and push go to NOTIFICATIONS_TEST_SINK_URL instead of Twilio and Expo. The
  // URL needs NOTIFICATIONS_ALLOW_TEST_SINK=true, which only NODE_ENV development
  // or test accepts (resolveNotificationTestSinkUrl below). Helm and CDK refuse both.
  NOTIFICATIONS_ALLOW_TEST_SINK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  NOTIFICATIONS_TEST_SINK_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),
});

export type ApiConfig = z.infer<typeof schema>;
export const config = schema.parse(process.env);

// Refuses the notification test sink unless NODE_ENV is development or test
// (unset included), or without the allow flag, so the process does not start
// (the senders check again, P11).
resolveNotificationTestSinkUrl(process.env);
