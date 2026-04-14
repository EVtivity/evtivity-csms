// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';

const dbConfigSchema = z.object({
  DATABASE_URL: z.string().url().default('postgres://evtivity:evtivity@localhost:5433/evtivity'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  DB_POOL_IDLE_TIMEOUT: z.coerce.number().int().nonnegative().default(30),
  DB_POOL_MAX_LIFETIME: z.coerce.number().int().positive().default(300),
});

const dbConfig = dbConfigSchema.parse(process.env);

const connectionString = dbConfig.DATABASE_URL;

/**
 * Connection pool configuration.
 *
 * max: Maximum connections in the pool. Default 20 balances typical API/OCPP
 *      workloads without exhausting PostgreSQL's default max_connections (100).
 *      Tune per deployment: (max_connections - superuser_reserved) / num_pods.
 * idle_timeout: Seconds before idle connections are closed. Prevents holding
 *               connections during low-traffic periods.
 * max_lifetime: Seconds before a connection is retired regardless of activity.
 *               Prevents issues with stale connections behind load balancers
 *               or PgBouncer.
 */
const client = postgres(connectionString, {
  onnotice: () => {},
  max: dbConfig.DB_POOL_MAX,
  idle_timeout: dbConfig.DB_POOL_IDLE_TIMEOUT,
  max_lifetime: dbConfig.DB_POOL_MAX_LIFETIME,
});

export const db = drizzle(client);

export { client };
