// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isMissingFileError } from './fs-errors.js';

// The repo `schemas/` folder: four levels up from packages/api/src/lib (source)
// and packages/api/dist/lib (tsc output). The production bundle has no source
// tree: scripts/build.mjs replaces this module with one that embeds every OCPP
// request schema (embedOcppSchemasPlugin), so the API image reads no file.
const SCHEMAS_ROOT = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

/**
 * The content of an OCPP schema file, by its path relative to `schemas/`
 * (`ocpp-2.1/ResetRequest.json`). Null when there is no such file.
 */
export async function readOcppSchemaFile(relativePath: string): Promise<string | null> {
  const filePath = `${SCHEMAS_ROOT}${relativePath}`;
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isMissingFileError(err)) return null;
    throw new Error(`Reading the OCPP schema ${filePath} failed`, { cause: err });
  }
}
