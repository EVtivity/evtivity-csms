// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * TC-AI-WK-06: AI never writes without a human. The
 * worker has no execution path for a proposal: no import of the API (its tool
 * executor and `app.inject` live there), no `inject(` call, and the AI worker
 * code makes no HTTP request to the API.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name.startsWith('__') ? [] : sourceFiles(path);
    }
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

/** The detection code the AI worker runs, in the services package. */
const DETECTION_DIR = resolve(import.meta.dirname, '../../../services/src/ai-workers');
const detectionFiles = sourceFiles(DETECTION_DIR).map((path) => ({
  path: relative(DETECTION_DIR, path),
  text: readFileSync(path, 'utf8'),
}));

const aiWorkerFiles = files.filter(
  (f) =>
    f.path.startsWith('ai-workers/') ||
    f.path === 'ai-worker-queue.ts' ||
    /^handlers\/ai-(network-summary|stuck-sessions|tariff-anomalies|proposal-sweep|proposal-digest)\.ts$/.test(
      f.path,
    ),
);

describe('the worker cannot run an AI proposal (TC-AI-WK-06)', () => {
  it('TC-AI-WK-06 scans the AI worker files', () => {
    expect(aiWorkerFiles.length).toBeGreaterThanOrEqual(7);
  });

  it('TC-AI-WK-06 no worker source imports the API or its tool executor', () => {
    const offenders = files.filter(
      (f) =>
        /from '@evtivity\/api(\/|')/.test(f.text) ||
        /import\(\s*['"]@evtivity\/api/.test(f.text) ||
        /services\/ai\/tools\/execute/.test(f.text) ||
        /executeConfirmedToolCall|runToolCall/.test(f.text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('TC-AI-WK-06 no worker source injects a request', () => {
    expect(files.filter((f) => /\.inject\(/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('TC-AI-WK-06 the AI worker code makes no HTTP call and holds no API address', () => {
    const offenders = aiWorkerFiles.filter((f) =>
      /\bfetch\(|API_BASE_URL|from 'undici'|from 'node:http/.test(f.text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('TC-AI-WK-06 proposals are written only through the proposal service', () => {
    const offenders = [...files, ...detectionFiles].filter(
      (f) =>
        /\baiProposals\b(?!:)/.test(f.text) ||
        /(INSERT INTO|UPDATE)\s+"?ai_proposals\b/i.test(f.text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('TC-AI-WK-06 the detection code in the services package runs nothing', () => {
    expect(detectionFiles.length).toBeGreaterThanOrEqual(6);
    const offenders = detectionFiles.filter((f) =>
      /@evtivity\/api|executeConfirmedToolCall|\.inject\(|\bfetch\(/.test(f.text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
