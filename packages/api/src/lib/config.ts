// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { resolveNotificationTestSinkUrl } from '@evtivity/lib/notification-test-sink';
import { resolveSimProviderTestBaseUrl } from '@evtivity/lib/sim-test-base-url';
import { parseTrustProxy } from '@evtivity/lib/trust-proxy';
import { webauthnRpIdProblem } from './webauthn-rp.js';

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
  // WebAuthn relying party ID (a domain, no scheme or port) for passkeys and
  // security keys. Empty (default) uses the host of CSMS_URL for operators and
  // of PORTAL_URL for drivers. A parent domain of both hosts lets the CSMS and
  // the portal share it; one that is not a parent of the portal host serves the
  // CSMS only, and the portal keeps its own host.
  WEBAUTHN_RP_ID: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  // Proxies in front of the API (Fastify trustProxy): empty (default) trusts
  // none, else a comma-separated list of proxy IPs or CIDRs. Behind it, the client
  // address (rate limits, audit and access logs) and the protocol come from
  // X-Forwarded-For and X-Forwarded-Proto. `true` is refused (spoofable).
  TRUST_PROXY: z
    .string()
    .default('')
    .transform((v, ctx) => {
      try {
        return parseTrustProxy(v);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
        return z.NEVER;
      }
    }),
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
  // SIM provider mock (local development and tests only, off by default): the
  // SIM provider adapters call this base URL instead of the vendor hosts. Only
  // NODE_ENV development or test accepts it (resolveSimProviderTestBaseUrl
  // below). Helm and CDK refuse it.
  SIM_PROVIDER_TEST_BASE_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),
});

export type ApiConfig = z.infer<typeof schema>;
export const config = schema.parse(process.env);

// A relying party ID the CSMS origin cannot use would fail every passkey
// ceremony, so the process refuses to start instead.
const rpIdProblem = webauthnRpIdProblem(config.WEBAUTHN_RP_ID, config.CSMS_URL);
if (rpIdProblem != null) throw new Error(`WEBAUTHN_RP_ID: ${rpIdProblem}`);

// Refuses the notification test sink unless NODE_ENV is development or test
// (unset included), or without the allow flag, so the process does not start
// (the senders check again, P11).
resolveNotificationTestSinkUrl(process.env);

// Refuses the SIM provider mock URL unless NODE_ENV is development or test, so
// provider credentials can never be sent to it in production.
resolveSimProviderTestBaseUrl(process.env);
