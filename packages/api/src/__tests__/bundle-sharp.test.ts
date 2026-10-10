// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const buildScript = path.join(repoRoot, 'scripts/build.mjs');
const outDir = path.join(repoRoot, 'node_modules/.cache/evtivity-bundle-test');

// Re-encodes a generated image, as the attachment pipeline does.
const ENTRY = `
import sharp from 'sharp';
const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer();
const { info } = await sharp(png).jpeg().toBuffer({ resolveWithObject: true });
process.stdout.write(info.format);
`;

async function bundleAndRun(external: string[], banner: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `sharp-${String(Date.now())}.mjs`);
  try {
    await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: path.join(repoRoot, 'packages/api'), loader: 'js' },
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outfile,
      external,
      banner: { js: banner },
      logLevel: 'silent',
    });
    return execFileSync(process.execPath, [outfile], { encoding: 'utf8', stdio: 'pipe' });
  } finally {
    rmSync(outfile, { force: true });
  }
}

describe('production bundle: sharp', () => {
  it('loads the native sharp module under the production build settings', async () => {
    const config = (await import(buildScript)) as { EXTERNAL: string[]; BANNER: string };

    expect(config.EXTERNAL).toContain('sharp');
    await expect(bundleAndRun(config.EXTERNAL, config.BANNER)).resolves.toBe('jpeg');
  }, 30_000);

  it('pins sharp to an exact version (libvips CVE surface, audited by npm audit)', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, 'packages/api/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['sharp']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
