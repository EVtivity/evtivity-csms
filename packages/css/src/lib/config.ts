// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url().default('postgres://evtivity:evtivity@localhost:5433/evtivity'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  OCPP_SERVER_URL: z.string().url().default('ws://localhost:7103'),
  OCPP_TLS_SERVER_URL: z.string().url().default('wss://localhost:8443'),
  // Enum-constrain so a typo (e.g. 'chaoss', 'CHAOS') fails fast at startup
  // instead of silently falling through to standby. Default to standby on
  // missing env. Per the simulator rule the only two valid modes are
  // 'standby' and 'chaos'.
  CSS_MODE: z.enum(['standby', 'chaos']).default('standby'),
  CSS_HEALTH_PORT: z.coerce.number().int().positive().default(8082),
  CSS_ACTION_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  CSS_STATION_LIMIT: z.coerce.number().int().nonnegative().default(0),
  CSS_STATION_PASSWORD: z.string().default('password'),
  // File paths to PEMs on disk. Used by the Helm chart, which mounts a
  // Kubernetes Secret as a volume.
  CSS_CLIENT_CERT: z.string().optional(),
  CSS_CLIENT_KEY: z.string().optional(),
  CSS_CA_CERT: z.string().optional(),
  // Inlined PEM strings. Used by the CDK / ECS Fargate path, which pulls
  // PEMs from a Secrets Manager JSON secret and injects each value as an env
  // variable. ECS has no equivalent of a Secret-as-file mount.
  CSS_CLIENT_CERT_PEM: z.string().optional(),
  CSS_CLIENT_KEY_PEM: z.string().optional(),
  CSS_CA_PEM: z.string().optional(),
});

export type SimulatorConfig = z.infer<typeof schema>;

export const config: SimulatorConfig = schema.parse(process.env);
