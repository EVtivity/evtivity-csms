// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { describe, it, expect } from 'vitest';
import { PROVIDER_IDS } from '../core/types.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const buildScript = path.join(repoRoot, 'scripts/build.mjs');

interface BuildConfig {
  EXTERNAL: string[];
  BANNER: string;
  WORKSPACE_PACKAGES: Record<string, string>;
  workspacePlugin: esbuild.Plugin;
  embedWasmPlugin: esbuild.Plugin;
  embedOcppSchemasPlugin: esbuild.Plugin;
}

async function loadConfig(): Promise<BuildConfig> {
  return (await import(buildScript)) as BuildConfig;
}

const SDK_INPUTS = [
  'node_modules/@anthropic-ai/sdk/',
  'node_modules/openai/',
  'node_modules/@google/genai/',
];

// Creates every adapter from the registry and reads each provider's default model entry.
const ENTRY = `
import { getModelEntry, listProviderEntries } from '@evtivity/ai/core';
import { getProviderRegistry } from '@evtivity/ai/providers';
const registry = getProviderRegistry();
const out = listProviderEntries().map((entry) => {
  const adapter = registry.create(entry.id, { apiKey: 'sk-test-0000000000' });
  const model = getModelEntry(entry.id, entry.defaultModel);
  return adapter.provider + ':' + (model === undefined ? 'missing' : 'ok');
});
process.stdout.write(out.join(','));
`;

describe('production bundles (TC-AI-PK-03)', () => {
  it('TC-AI-PK-03 the build maps @evtivity/ai to its source and bundles the SDKs', async () => {
    const config = await loadConfig();
    expect(config.WORKSPACE_PACKAGES['@evtivity/ai']).toBe(path.join(repoRoot, 'packages/ai'));
    for (const sdk of ['@anthropic-ai/sdk', 'openai', '@google/genai']) {
      expect(config.EXTERNAL).not.toContain(sdk);
    }
  });

  it('TC-AI-PK-03 the API bundle contains every adapter and its SDK', async () => {
    const config = await loadConfig();
    const result = await esbuild.build({
      entryPoints: [path.join(repoRoot, 'packages/api/src/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile: path.join(tmpdir(), 'evtivity-api-bundle-test.mjs'),
      write: false,
      metafile: true,
      external: config.EXTERNAL,
      plugins: [config.workspacePlugin, config.embedWasmPlugin, config.embedOcppSchemasPlugin],
      loader: { '.wasm': 'binary' },
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    for (const id of PROVIDER_IDS) {
      expect(inputs, id).toContain(`packages/ai/src/providers/${id}/adapter.ts`);
    }
    for (const sdk of SDK_INPUTS) {
      expect(
        inputs.some((input) => input.includes(sdk)),
        sdk,
      ).toBe(true);
    }
  }, 120_000);

  // The worker runs insight model calls (roadmap v0.1.44, decision D1): its
  // real entry must bundle every adapter and SDK, as the API's does.
  it('TC-AI-PK-03 the worker bundle contains every adapter, its SDK and the insight worker', async () => {
    const config = await loadConfig();
    const result = await esbuild.build({
      entryPoints: [path.join(repoRoot, 'packages/worker/src/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile: path.join(tmpdir(), 'evtivity-worker-bundle-test.mjs'),
      write: false,
      metafile: true,
      external: config.EXTERNAL,
      plugins: [config.workspacePlugin, config.embedWasmPlugin, config.embedOcppSchemasPlugin],
      loader: { '.wasm': 'binary' },
      logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    for (const id of PROVIDER_IDS) {
      expect(inputs, id).toContain(`packages/ai/src/providers/${id}/adapter.ts`);
    }
    for (const sdk of SDK_INPUTS) {
      expect(
        inputs.some((input) => input.includes(sdk)),
        sdk,
      ).toBe(true);
    }
    expect(inputs).toContain('packages/worker/src/ai-insight-worker.ts');
    expect(inputs).toContain('packages/worker/src/ai-insights/generate.ts');
  }, 120_000);

  // The worker bundle uses the same settings. The bundle runs from a directory
  // outside the repository, so an SDK left out of it could not be loaded.
  it('TC-AI-PK-03 a bundle under the worker build settings creates every adapter and loads the registry', async () => {
    const config = await loadConfig();
    const outDir = mkdtempSync(path.join(tmpdir(), 'evtivity-ai-bundle-'));
    const outfile = path.join(outDir, 'ai.mjs');
    try {
      await esbuild.build({
        stdin: {
          contents: ENTRY,
          resolveDir: path.join(repoRoot, 'packages/worker'),
          loader: 'js',
        },
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'esm',
        outfile,
        external: config.EXTERNAL,
        plugins: [config.workspacePlugin],
        banner: { js: config.BANNER },
        logLevel: 'silent',
      });
      const output = execFileSync(process.execPath, [outfile], {
        cwd: outDir,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      expect(output.split(',').sort()).toEqual(PROVIDER_IDS.map((id) => `${id}:ok`).sort());
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
