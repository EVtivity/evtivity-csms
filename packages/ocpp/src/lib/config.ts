// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  OCPP_PORT: z.coerce.number().int().positive(),
  OCPP_HOST: z.string().default('0.0.0.0'),
  OCPP_HEALTH_PORT: z.coerce.number().int().positive().default(8081),
  OCPP_TLS_PORT: z.coerce.number().int().positive().optional(),
  OCPP_TLS_CERT: z.string().optional(),
  OCPP_TLS_KEY: z.string().optional(),
  OCPP_TLS_CA: z.string().optional(),
  DATABASE_URL: z.string().url().default('postgres://evtivity:evtivity@localhost:5433/evtivity'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SETTINGS_ENCRYPTION_KEY: z.string().min(1),
  OCPP_INSTANCE_ID: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  OCPP_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().positive().default(2500),
  OCPP_MAX_MESSAGES_PER_IP_PER_SECOND: z.coerce.number().int().positive().default(5000),
});

export type OcppConfig = z.infer<typeof schema>;

export const config = schema.parse(process.env);
