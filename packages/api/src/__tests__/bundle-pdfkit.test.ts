// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const buildScript = path.join(repoRoot, 'scripts/build.mjs');
const outDir = path.join(repoRoot, 'node_modules/.cache/evtivity-bundle-test');

// Renders a PDF with a standard font, as the invoice PDF does.
const ENTRY = `
import PDFDocument from 'pdfkit';
const doc = new PDFDocument();
const chunks = [];
doc.on('data', (chunk) => chunks.push(chunk));
doc.on('end', () => process.stdout.write(Buffer.concat(chunks).subarray(0, 5).toString('latin1')));
doc.font('Helvetica').text('Invoice');
doc.end();
`;

async function bundleAndRun(external: string[], banner: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, `pdf-${String(Date.now())}.mjs`);
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
    return execFileSync(process.execPath, [outfile], { encoding: 'latin1', stdio: 'pipe' });
  } finally {
    rmSync(outfile, { force: true });
  }
}

describe('production bundle', () => {
  it('renders a PDF with pdfkit under the production build settings', async () => {
    const config = (await import(buildScript)) as { EXTERNAL: string[]; BANNER: string };

    expect(config.EXTERNAL).toContain('pdfkit');
    await expect(bundleAndRun(config.EXTERNAL, config.BANNER)).resolves.toBe('%PDF-');
  }, 30_000);

  it('fails when pdfkit is bundled, because it reads its fonts through __dirname', async () => {
    const config = (await import(buildScript)) as { EXTERNAL: string[]; BANNER: string };
    const withoutPdfkit = config.EXTERNAL.filter((name) => name !== 'pdfkit');

    await expect(bundleAndRun(withoutPdfkit, config.BANNER)).rejects.toThrow(/__dirname/);
  }, 30_000);
});
