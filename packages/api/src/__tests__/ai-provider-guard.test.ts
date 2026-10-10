// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getModelEntry, listProviderEntries } from '../services/ai/core/model-registry.js';
import { EFFORTS, PROVIDER_IDS } from '../services/ai/core/types.js';
import { PROVIDER_ADAPTER_FACTORIES, getProviderRegistry } from '../services/ai/providers/index.js';

const SRC = join(import.meta.dirname, '..');
const PROVIDERS = join(SRC, 'services', 'ai', 'providers');

/** SDK modules each adapter folder may import. */
const SDKS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['@anthropic-ai/sdk'],
  openai: ['openai'],
  deepseek: ['openai'],
  gemini: ['@google/genai'],
};
const ALL_SDKS = ['@anthropic-ai/sdk', 'openai', '@google/genai', '@google/generative-ai'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function importedSdks(code: string): string[] {
  const found = new Set<string>();
  const re = /(?:from\s+|import\s*\(\s*|vi\.mock\(\s*|import\s+)['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(re)) {
    const spec = m[1] ?? '';
    const sdk = ALL_SDKS.find((s) => spec === s || spec.startsWith(`${s}/`));
    if (sdk !== undefined) found.add(sdk);
  }
  return [...found];
}

const NAME_COMPARISON =
  /(?:[!=]==?\s*['"](?:anthropic|openai|gemini|deepseek)['"])|(?:['"](?:anthropic|openai|gemini|deepseek)['"]\s*[!=]==?)|(?:case\s+['"](?:anthropic|openai|gemini|deepseek)['"])/;

describe('AI provider isolation (TC-AI-P-10)', () => {
  const files = sourceFiles(SRC);

  it('TC-AI-P-10 no provider SDK import outside its adapter folder', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sdks = importedSdks(readFileSync(file, 'utf8'));
      if (sdks.length === 0) continue;
      const rel = relative(PROVIDERS, file);
      const folder = rel.startsWith('..') ? undefined : rel.split(sep)[0];
      const allowed = folder !== undefined ? (SDKS[folder] ?? []) : [];
      for (const sdk of sdks) {
        if (!allowed.includes(sdk)) offenders.push(`${relative(SRC, file)} imports ${sdk}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('TC-AI-P-10 no provider-name comparison outside the adapters and tests', () => {
    const offenders = files
      .filter((f) => !f.startsWith(PROVIDERS + sep) && !f.includes(`${sep}__tests__${sep}`))
      .filter((f) => !f.includes(`${sep}__integration__${sep}`))
      .filter((f) => NAME_COMPARISON.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('TC-AI-P-10 the legacy SDK package is gone', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@google/generative-ai']).toBeUndefined();
    expect(Object.keys(pkg.dependencies)).toEqual(
      expect.arrayContaining(['@anthropic-ai/sdk', 'openai', '@google/genai']),
    );
  });
});

describe('model and provider registry (TC-AI-P-15)', () => {
  it('TC-AI-P-15 every default and router model is listed, flags complete', () => {
    for (const entry of listProviderEntries()) {
      expect(getModelEntry(entry.id, entry.defaultModel), entry.defaultModel).toBeDefined();
      expect(getModelEntry(entry.id, entry.routerModel), entry.routerModel).toBeDefined();
      for (const model of entry.models) {
        const caps = model.capabilities;
        expect(caps.streaming).toBe(true);
        expect(caps.maxContextTokens).toBeGreaterThan(0);
        expect(caps.maxOutputTokens).toBeGreaterThan(0);
        expect(caps.samplingParams).toBe(false);
        expect(caps.effort.every((e) => (EFFORTS as readonly string[]).includes(e))).toBe(true);
        if (caps.vision !== false) {
          expect(caps.vision.formats.length).toBeGreaterThan(0);
          expect(caps.vision.maxImages).toBeGreaterThan(0);
        }
      }
    }
  });

  it('TC-AI-P-15 every provider has an adapter factory whose adapter reports registry capabilities', () => {
    const registry = getProviderRegistry();
    expect(registry.available()).toEqual([...PROVIDER_IDS]);
    for (const id of PROVIDER_IDS) {
      expect(PROVIDER_ADAPTER_FACTORIES[id]).toBeTypeOf('function');
      const adapter = registry.create(id, { apiKey: 'sk-test-0000000000' });
      expect(adapter.provider).toBe(id);
      const entry = listProviderEntries().find((e) => e.id === id);
      expect(adapter.capabilities(entry?.defaultModel ?? '')).toEqual(
        getModelEntry(id, entry?.defaultModel ?? '')?.capabilities,
      );
    }
  });
});
