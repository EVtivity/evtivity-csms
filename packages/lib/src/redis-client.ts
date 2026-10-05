// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { Redis, type RedisOptions } from 'ioredis';
import { logRedisErrors } from './redis-errors.js';

/**
 * TLS options for a Redis URL.
 *
 * A `rediss://` URL connects over TLS. By default ioredis verifies the server
 * against the system CAs (enough for ElastiCache). A Redis with a private CA
 * (the Helm chart's bundled Redis with TLS on) sets the CA with
 * REDIS_TLS_CA_PEM (the PEM itself, as the chart injects it from a Secret) or
 * REDIS_TLS_CA_FILE (a path to the PEM). Setting a CA with a plain `redis://`
 * URL, or both variables, throws: TLS was meant but would not be used, which
 * must fail at startup instead of silently sending passwords in clear text.
 */
export function redisTlsOptions(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Pick<RedisOptions, 'tls'> {
  const pem = env['REDIS_TLS_CA_PEM'] ?? '';
  const file = env['REDIS_TLS_CA_FILE'] ?? '';
  if (pem !== '' && file !== '') {
    throw new Error('Set REDIS_TLS_CA_PEM or REDIS_TLS_CA_FILE, not both');
  }
  const tls = /^rediss:\/\//i.test(url);
  if (!tls) {
    if (pem !== '' || file !== '') {
      throw new Error(
        'REDIS_TLS_CA_PEM or REDIS_TLS_CA_FILE is set but the Redis URL is not rediss://',
      );
    }
    return {};
  }
  if (pem !== '') return { tls: { ca: pem } };
  if (file !== '') return { tls: { ca: readFileSync(file, 'utf8') } };
  return {};
}

/**
 * Creates an ioredis client for the URL with the TLS options of
 * {@link redisTlsOptions} and connection errors logged at warn. Every process
 * creates its Redis clients through this (or through helpers that call it).
 */
export function createRedisClient(url: string, name: string, options: RedisOptions = {}): Redis {
  return logRedisErrors(new Redis(url, { ...options, ...redisTlsOptions(url) }), name);
}
