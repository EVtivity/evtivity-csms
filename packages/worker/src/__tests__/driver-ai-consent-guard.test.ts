// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * TC-AI-DR-20: no driver AI model call without consent and a ledger row
 * (plan v0.1.45, section 2.9, layer 4). Every source file under
 * `packages/worker/src/driver-ai/` that calls a model (`.complete(` or
 * `.stream(` of an adapter) must call `assertDriverAiConsent` before the call,
 * in that file or in the file that calls its model helper, and record the
 * call's usage with `recordAiUsage`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = resolve(import.meta.dirname, '../driver-ai');

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));

const MODEL_CALL = /\.(?:complete|stream)\(/;

describe('driver AI model calls follow the consent check (TC-AI-DR-20)', () => {
  it('TC-AI-DR-20 scans the driver AI files and finds the model call', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.filter((f) => MODEL_CALL.test(f.text)).map((f) => f.name)).toEqual(['analyze.ts']);
  });

  it('TC-AI-DR-20 every file with a model call asserts consent before it and records usage', () => {
    for (const f of files.filter((file) => MODEL_CALL.test(file.text))) {
      const call = f.text.search(MODEL_CALL);
      // The helper that makes the call runs only from the job, after the assert.
      const helper = f.text.lastIndexOf('export async function', call);
      const helperName = /export async function (\w+)/.exec(f.text.slice(helper))?.[1] ?? '';
      const assertAt = f.text.indexOf('assertDriverAiConsent(caseId');
      const helperUse = f.text.indexOf(`await ${helperName}(`, assertAt);
      expect(assertAt, `${f.name}: assertDriverAiConsent`).toBeGreaterThan(0);
      expect(helperUse, `${f.name}: ${helperName} runs after the consent check`).toBeGreaterThan(
        assertAt,
      );
      // Only the guarded call site runs the helper.
      expect(f.text.split(`${helperName}(`).length - 1, `${f.name}: ${helperName} callers`).toBe(2);
      expect(f.text.slice(helper), `${f.name}: recordAiUsage`).toMatch(/recordAiUsage\(/);
    }
  });

  it('TC-AI-DR-20 no other worker or services file calls the driver AI model helper', () => {
    const root = resolve(import.meta.dirname, '..');
    const offenders = readdirSync(root, { recursive: true })
      .map(String)
      .filter(
        (p) =>
          p.endsWith('.ts') &&
          !p.includes('__tests__') &&
          !p.includes('__integration__') &&
          !p.startsWith('driver-ai/'),
      )
      .filter((p) =>
        /askDriverAiModel|createDriverAiAdapter\(/.test(readFileSync(join(root, p), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
