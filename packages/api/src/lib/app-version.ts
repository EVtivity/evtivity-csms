// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryParseJson } from '@evtivity/lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readVersion(): string {
  for (const candidate of [
    resolve(__dirname, '../../package.json'),
    resolve(__dirname, '../package.json'),
    resolve(__dirname, '../../../package.json'),
  ]) {
    if (!existsSync(candidate)) continue;
    const pkg = tryParseJson(readFileSync(candidate, 'utf8')) as { version?: unknown } | undefined;
    if (typeof pkg?.version === 'string' && pkg.version !== '') return pkg.version;
  }
  return process.env['npm_package_version'] ?? 'unknown';
}

export const APP_VERSION = readVersion();
