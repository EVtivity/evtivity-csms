// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readFileSync } from 'node:fs';

// The repository `schemas/` folder: three levels up from packages/octt/src
// (source) and packages/octt/dist (tsc output). A service bundle has no source
// tree: scripts/build.mjs replaces this module with one that embeds every OCPP
// schema (embedOcttSchemasPlugin), so the worker image reads no file.
const SCHEMAS_ROOT = new URL('../../../schemas/', import.meta.url);

// The only names a schema has: `ocpp-2.1/<Action>Request.json` and
// `<Action>Response.json`, the same for `ocpp-2.0.1/`, and
// `ocpp-1.6/<Action>.json` and `<Action>Response.json`.
const SCHEMA_PATH_PATTERN = /^ocpp-(?:2\.1|2\.0\.1|1\.6)\/[A-Za-z0-9]{1,100}\.json$/;

/**
 * The content of an OCPP schema file, by its path relative to `schemas/`
 * (`ocpp-2.1/ResetRequest.json`). Null when there is no such file.
 */
export function readOcppSchemaText(relativePath: string): string | null {
  if (!SCHEMA_PATH_PATTERN.test(relativePath)) return null;
  const url = new URL(relativePath, SCHEMAS_ROOT);
  return existsSync(url) ? readFileSync(url, 'utf8') : null;
}
