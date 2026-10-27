// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.url().default('postgres://evtivity:evtivity@localhost:5433/evtivity'),
  // Connection pool size, as for the other services (@evtivity/database).
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  OCPP_SERVER_URL: z.url().default('ws://localhost:7103'),
  OCPP_TLS_SERVER_URL: z.url().default('wss://localhost:8443'),
  // The TLS address the CSMS gives stations moved to TLS (the API's value).
  // A simulator moved to TLS by a security profile change connects there.
  OCPP_STATION_TLS_URL: z.url().optional(),
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
  // Development relaxations (private network file transfers) need development or test.
  NODE_ENV: z.string().optional(),
  // Hosts (host or host:port, comma-separated) a station may reach on a loopback or
  // private address for log uploads and firmware downloads, such as the Compose test
  // servers. Outside development and test every other private address is refused;
  // unroutable and cloud metadata addresses are refused always.
  CSS_FILE_TRANSFER_ALLOWED_HOSTS: z.string().default(''),
  // The SFTP server host key a station verifies (OpenSSH SHA256 fingerprint) while it
  // verifies servers (TLS_REJECT_UNAUTHORIZED not false). Unset: sftp fails closed then.
  CSS_SFTP_HOST_KEY_SHA256: z.string().optional(),
});

export type SimulatorConfig = z.infer<typeof schema>;

export const config: SimulatorConfig = schema.parse(process.env);

/**
 * The OCPP server URLs a simulator may connect to: the plain and TLS
 * endpoints and the TLS address the CSMS gives stations moved to TLS. A stored
 * or network-profile URL on another origin is never connected to.
 */
export function simulatorServerUrls(): Array<string | undefined> {
  return [config.OCPP_SERVER_URL, config.OCPP_TLS_SERVER_URL, config.OCPP_STATION_TLS_URL];
}

/** Whether file transfers may reach any private address (development and test only). */
export function fileTransferAllowsPrivateNetworks(): boolean {
  return config.NODE_ENV === 'development' || config.NODE_ENV === 'test';
}

/** CSS_FILE_TRANSFER_ALLOWED_HOSTS as a list. */
export function fileTransferAllowedHosts(): string[] {
  return config.CSS_FILE_TRANSFER_ALLOWED_HOSTS.split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
}
