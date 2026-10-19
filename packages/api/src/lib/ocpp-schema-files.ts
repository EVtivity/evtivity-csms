// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMissingFileError } from './fs-errors.js';

// The repo `schemas/` folder: four levels up from packages/api/src/lib (source)
// and packages/api/dist/lib (tsc output). The production bundle has no source
// tree: scripts/build.mjs replaces this module with one that embeds every OCPP
// request schema (embedOcppSchemasPlugin), so the API image reads no file.
const SCHEMAS_ROOT = resolve(fileURLToPath(new URL('../../../../schemas/', import.meta.url)));

// The only names a request schema has: `ocpp-2.1/<Action>Request.json`,
// `ocpp-2.0.1/<Action>Request.json` and
// `ocpp-1.6/<Action>.json`, the action in letters and digits.
const SCHEMA_PATH_PATTERN = /^ocpp-(?:2\.1|2\.0\.1|1\.6)\/[A-Za-z0-9]{1,100}\.json$/;

/**
 * The absolute path of a schema file, or null when the relative path is not a
 * schema name or resolves outside `schemas/`.
 */
export function ocppSchemaFilePath(relativePath: string): string | null {
  if (!SCHEMA_PATH_PATTERN.test(relativePath)) return null;
  const filePath = resolve(SCHEMAS_ROOT, relativePath);
  if (!filePath.startsWith(SCHEMAS_ROOT + sep)) return null;
  return filePath;
}

/**
 * The content of an OCPP schema file, by its path relative to `schemas/`
 * (`ocpp-2.1/ResetRequest.json`). Null when there is no such file.
 */
export async function readOcppSchemaFile(relativePath: string): Promise<string | null> {
  const filePath = ocppSchemaFilePath(relativePath);
  if (filePath === null) return null;
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isMissingFileError(err)) return null;
    throw new Error(`Reading the OCPP schema ${filePath} failed`, { cause: err });
  }
}
