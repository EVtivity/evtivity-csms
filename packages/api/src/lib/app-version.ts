// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readVersion(): string {
  for (const candidate of [
    resolve(__dirname, '../../package.json'),
    resolve(__dirname, '../package.json'),
    resolve(__dirname, '../../../package.json'),
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version != null && pkg.version !== '') return pkg.version;
    } catch {
      /* try next candidate */
    }
  }
  return process.env['npm_package_version'] ?? 'unknown';
}

export const APP_VERSION = readVersion();
