// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const buildScript = path.join(repoRoot, 'scripts/build.mjs');
const indexTs = path.join(repoRoot, 'packages/v2g-exi/src/index.ts');

// Encodes and decodes an ISO 15118-2 request with the codec.
const ENTRY = `
import { decodeMessage, encodeMessage } from ${JSON.stringify(indexTs)};
const { exi } = encodeMessage({
  schema: 2,
  sessionId: '01',
  body: {
    type: 'CertificateInstallationReq',
    id: 'id1',
    oemProvisioningCert: Buffer.alloc(10, 1),
    rootCertificateIds: [{ issuerName: 'CN=Root', serialNumber: '01' }],
  },
});
process.stdout.write(decodeMessage(2, exi).body.type);
`;

async function bundleAndRun(plugins: esbuild.Plugin[]): Promise<string> {
  // Outside the repository, so the bundle cannot read the module from disk.
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'v2g-exi-bundle-'));
  const outfile = path.join(outDir, 'bundle.mjs');
  try {
    await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: repoRoot, loader: 'ts' },
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile,
      plugins,
      loader: { '.wasm': 'binary' },
      logLevel: 'silent',
    });
    return execFileSync(process.execPath, [outfile], { encoding: 'utf8', stdio: 'pipe' });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

describe('production bundle', () => {
  it('embeds the WebAssembly module so the bundle runs on its own', async () => {
    const config = (await import(buildScript)) as { embedWasmPlugin: esbuild.Plugin };
    await expect(bundleAndRun([config.embedWasmPlugin])).resolves.toBe(
      'CertificateInstallationReq',
    );
  }, 30_000);

  it('cannot find the module without the embedding plugin', async () => {
    await expect(bundleAndRun([])).rejects.toThrow(/v2g_exi\.wasm|ENOENT/);
  }, 30_000);
});
