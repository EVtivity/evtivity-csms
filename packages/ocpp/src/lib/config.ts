// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

// Compose passes an unset variable as an empty string.
function optionalInt<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

const schema = z.object({
  OCPP_PORT: z.coerce.number().int().positive(),
  OCPP_HOST: z.string().default('0.0.0.0'),
  OCPP_HEALTH_PORT: z.coerce.number().int().positive().default(8081),
  OCPP_TLS_PORT: z.coerce.number().int().positive().optional(),
  // File paths to PEMs on disk. Used by the Helm chart, which mounts
  // Kubernetes Secret data as files via a volumeMount.
  OCPP_TLS_CERT: z.string().optional(),
  OCPP_TLS_KEY: z.string().optional(),
  OCPP_TLS_CA: z.string().optional(),
  // Inlined PEM strings. Used by the CDK / ECS Fargate path, which pulls
  // PEMs from a Secrets Manager JSON secret and injects each value as an env
  // variable. ECS has no equivalent of a Secret-as-file mount.
  OCPP_TLS_CERT_PEM: z.string().optional(),
  OCPP_TLS_KEY_PEM: z.string().optional(),
  OCPP_TLS_CA_PEM: z.string().optional(),
  DATABASE_URL: z.string().url().default('postgres://evtivity:evtivity@localhost:5433/evtivity'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SETTINGS_ENCRYPTION_KEY: z.string().min(1),
  OCPP_INSTANCE_ID: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  OCPP_TRUSTED_PROXY_CIDRS: z.string().default(''),
  OCPP_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(2500),
  OCPP_MAX_MESSAGES_PER_IP_PER_SECOND: z.coerce.number().int().positive().default(5000),
  // Station connection authentications (connection-auth-limiter.ts). Unset or
  // empty: half of DB_POOL_MAX run at once, 1000 wait, for at most 10 s.
  OCPP_AUTH_MAX_CONCURRENT: optionalInt(z.coerce.number().int().positive()),
  OCPP_AUTH_MAX_QUEUED: optionalInt(z.coerce.number().int().nonnegative()),
  OCPP_AUTH_MAX_WAIT_MS: optionalInt(z.coerce.number().int().positive()),
  // Allows the simulated (test) payment provider in this process (D-T1). Default:
  // on when NODE_ENV is development (or unset) or test, off otherwise.
  PAYMENTS_ALLOW_SIMULATED: z
    .enum(['true', 'false'])
    .default(
      ['development', 'test'].includes(process.env['NODE_ENV'] ?? 'development') ? 'true' : 'false',
    )
    .transform((v) => v === 'true'),
});

export type OcppConfig = z.infer<typeof schema>;

export const config = schema.parse(process.env);
