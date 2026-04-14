// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Set defaults so buildApp() can initialize without a running environment.
// JWT_SECRET must be set to a non-guessable value even for spec generation,
// because the JWT plugin validates its presence on startup.
process.env['API_PORT'] ??= '3001';
process.env['CORS_ORIGIN'] ??= 'http://localhost';
process.env['JWT_SECRET'] ??= `openapi-gen-${crypto.randomUUID()}`;

import { buildApp } from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function generate(): Promise<void> {
  const app = await buildApp({ logger: false });
  await app.ready();

  const spec = app.swagger();
  const outPath = resolve(__dirname, '..', 'openapi.json');
  writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');

  console.log(`OpenAPI spec written to ${outPath}`);
  await app.close();
}

generate().catch((err: unknown) => {
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
