// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Prefix of the Postgres `application_name` every EVtivity process sets from
 * v0.1.38 on. Releases before it never set one, so postgres.js sent its
 * default (`LEGACY_CONNECTION_NAME`). A connection carrying this prefix
 * belongs to a process that knows the provider-switch guard (Payments P10).
 */
export const CONNECTION_NAME_PREFIX = 'evtivity@';

/** The `application_name` postgres.js sends when none is set (releases before v0.1.38). */
export const LEGACY_CONNECTION_NAME = 'postgres.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  // src/ and dist/ sit next to the package's package.json; the esbuild bundle
  // runs from /app/dist next to the root package.json. release.sh bumps every
  // package.json together, so either file carries the release version.
  for (const candidate of [
    resolve(moduleDir, '../package.json'),
    resolve(moduleDir, '../../package.json'),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version != null && pkg.version !== '') return pkg.version;
    } catch {
      // fail-open: the package.json is not there in this layout, try the next candidate
    }
  }
  return 'unknown';
}

const name = `${CONNECTION_NAME_PREFIX}${readVersion()}`;

/**
 * The Postgres `application_name` for this process, `evtivity@<version>`.
 * Pass it to every `postgres()` call as `connection: { application_name }`,
 * so `pg_stat_activity` tells processes of this release from older ones.
 */
export function connectionName(): string {
  return name;
}
