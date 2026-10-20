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
const readerTs = path.join(repoRoot, 'packages/octt/src/ocpp-schema-files.ts');

// Reads a request, a response and a SEND schema of each version, and a
// missing one, through the reader the conformance schema check uses.
const ENTRY = `
import { readOcppSchemaText } from ${JSON.stringify(readerTs)};
const names = [
  'ocpp-2.1/ResetRequest.json',
  'ocpp-2.1/NotifyPeriodicEventStream.json',
  'ocpp-2.0.1/ResetResponse.json',
  'ocpp-1.6/RemoteStartTransaction.json',
  'ocpp-1.6/RemoteStartTransactionResponse.json',
  'ocpp-2.1/NoSuchActionRequest.json',
];
process.stdout.write(JSON.stringify(names.map((n) => {
  const text = readOcppSchemaText(n);
  return text == null ? null : (JSON.parse(text).required ?? []);
})));
`;

async function bundleAndRun(plugins: esbuild.Plugin[]): Promise<unknown> {
  // Outside the repository, like /app/dist/worker.mjs in the image: a path
  // relative to the bundle cannot reach the repo schemas folder.
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'octt-schemas-bundle-'));
  const outfile = path.join(outDir, 'dist', 'worker.mjs');
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

describe('worker bundle', () => {
  it('embeds the OCPP schemas so the conformance schema check runs without a schemas folder', async () => {
    const config = (await import(buildScript)) as { embedOcttSchemasPlugin: esbuild.Plugin };
    await expect(bundleAndRun([config.embedOcttSchemasPlugin])).resolves.toEqual([
      ['type'],
      ['id', 'pending', 'basetime', 'data'],
      ['status'],
      ['idTag'],
      ['status'],
      null,
    ]);
  }, 30_000);

  it('finds no schema without the embedding plugin', async () => {
    await expect(bundleAndRun([])).resolves.toEqual([null, null, null, null, null, null]);
  }, 30_000);

  it('embeds every schema file of the three versions', async () => {
    const config = (await import(buildScript)) as {
      embeddedOcttSchemas: () => Record<string, string>;
    };
    const expected = ['ocpp-2.1', 'ocpp-2.0.1', 'ocpp-1.6'].flatMap((dir) =>
      readdirSync(path.join(repoRoot, 'schemas', dir))
        .filter((f) => f.endsWith('.json'))
        .map((f) => `${dir}/${f}`),
    );
    expect(Object.keys(config.embeddedOcttSchemas()).sort()).toEqual(expected.sort());
  });
});
