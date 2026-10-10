// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const buildScript = path.join(repoRoot, 'scripts/build.mjs');
const readerTs = path.join(repoRoot, 'packages/api/src/lib/ocpp-schema-files.ts');

// Reads one schema per OCPP version and a missing one through the reader the
// schema routes use, and prints what it got.
const ENTRY = `
import { readOcppSchemaFile } from ${JSON.stringify(readerTs)};
const v21 = await readOcppSchemaFile('ocpp-2.1/RequestStartTransactionRequest.json');
const v16 = await readOcppSchemaFile('ocpp-1.6/RemoteStartTransaction.json');
const missing = await readOcppSchemaFile('ocpp-2.1/NoSuchActionRequest.json');
process.stdout.write(JSON.stringify({
  v21: v21 == null ? null : Object.keys(JSON.parse(v21).properties),
  v16: v16 == null ? null : JSON.parse(v16).required,
  missing,
}));
`;

async function bundleAndRun(plugins: esbuild.Plugin[]): Promise<unknown> {
  // Outside the repository, like /app/dist/api.mjs in the image: a path
  // relative to the bundle cannot reach the repo schemas folder.
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'ocpp-schemas-bundle-'));
  const outfile = path.join(outDir, 'dist', 'api.mjs');
  try {
    await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: repoRoot, loader: 'ts' },
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile,
      plugins,
      logLevel: 'silent',
    });
    return JSON.parse(
      execFileSync(process.execPath, [outfile], { encoding: 'utf8', stdio: 'pipe', cwd: outDir }),
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe('production bundle', () => {
  it('embeds the OCPP request schemas so the bundle serves them without a schemas folder', async () => {
    const config = (await import(buildScript)) as { embedOcppSchemasPlugin: esbuild.Plugin };
    await expect(bundleAndRun([config.embedOcppSchemasPlugin])).resolves.toEqual({
      v21: expect.arrayContaining(['idToken', 'remoteStartId']) as unknown,
      v16: ['idTag'],
      missing: null,
    });
  }, 30_000);

  it('finds no schema without the embedding plugin (the v0.1.42 404)', async () => {
    await expect(bundleAndRun([])).resolves.toEqual({ v21: null, v16: null, missing: null });
  }, 30_000);

  it('embeds every request schema of both versions and no response schema', async () => {
    const config = (await import(buildScript)) as {
      embeddedOcppSchemas: () => Record<string, string>;
    };
    const embedded = Object.keys(config.embeddedOcppSchemas());
    const v21 = readdirSync(path.join(repoRoot, 'schemas/ocpp-2.1')).filter((f) =>
      f.endsWith('Request.json'),
    );
    const v16 = readdirSync(path.join(repoRoot, 'schemas/ocpp-1.6')).filter(
      (f) => !f.endsWith('Response.json'),
    );

    expect(embedded.sort()).toEqual(
      [...v21.map((f) => `ocpp-2.1/${f}`), ...v16.map((f) => `ocpp-1.6/${f}`)].sort(),
    );
  });
});
