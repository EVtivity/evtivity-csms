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
  SETTINGS_ENCRYPTION_KEY: z.string().default(''),
  CSMS_URL: z.string().default('http://localhost:7100'),
  PORTAL_URL: z.string().default('http://localhost:7101'),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  COOKIE_DOMAIN: z.string().optional(),
});

export type ApiConfig = z.infer<typeof schema>;
export const config = schema.parse(process.env);
