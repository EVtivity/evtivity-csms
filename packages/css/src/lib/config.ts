// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url().default('postgres://evtivity:evtivity@localhost:5433/evtivity'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  OCPP_SERVER_URL: z.string().url().default('ws://localhost:7103'),
  OCPP_TLS_SERVER_URL: z.string().url().default('wss://localhost:8443'),
  CSS_MODE: z.string().default('standby'),
  CSS_HEALTH_PORT: z.coerce.number().int().positive().default(8082),
  CSS_ACTION_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  CSS_STATION_LIMIT: z.coerce.number().int().nonnegative().default(0),
  CSS_STATION_PASSWORD: z.string().default('password'),
  CSS_CLIENT_CERT: z.string().optional(),
  CSS_CLIENT_KEY: z.string().optional(),
  CSS_CA_CERT: z.string().optional(),
});

export type SimulatorConfig = z.infer<typeof schema>;

export const config: SimulatorConfig = schema.parse(process.env);
