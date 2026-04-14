// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  OCPI_PORT: z.coerce.number().int().positive(),
  OCPI_HOST: z.string().default('0.0.0.0'),
  OCPI_COUNTRY_CODE: z.string().length(2).default('US'),
  OCPI_PARTY_ID: z.string().min(1).max(3).default('EVT'),
  OCPI_BUSINESS_NAME: z.string().default('EVtivity'),
  OCPI_WEBSITE: z.string().url().optional(),
  OCPI_BASE_URL: z.string().url().default('http://localhost:7104'),
  DATABASE_URL: z.string().url().default('postgres://evtivity:evtivity@localhost:5433/evtivity'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SETTINGS_ENCRYPTION_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type OcpiConfig = z.infer<typeof schema>;

export const config: OcpiConfig = schema.parse(process.env);
