// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getModelEntry, listProviderEntries } from '../core/model-registry.js';
import { EFFORTS, PROVIDER_IDS } from '../core/types.js';
import { PROVIDER_ADAPTER_FACTORIES, getProviderRegistry } from '../providers/index.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PACKAGES = join(ROOT, 'packages');
const PROVIDERS = join(PACKAGES, 'ai', 'src', 'providers');

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
    if (name === 'node_modules' || name === 'dist') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(name) ? [path] : [];
  });
}

/** Source, tests, E2E code and scripts of every workspace package, plus the root E2E helpers and scripts. */
function workspaceFiles(): string[] {
  const roots = readdirSync(PACKAGES).flatMap((pkg) =>
    ['src', 'e2e', 'scripts'].map((dir) => join(PACKAGES, pkg, dir)),
  );
  roots.push(join(ROOT, 'e2e'), join(ROOT, 'scripts'));
  return roots.filter((dir) => existsSync(dir)).flatMap((dir) => sourceFiles(dir));
}

function importedSdks(code: string): string[] {
  const found = new Set<string>();
  const re = /(?:from\s+|import\s*\(\s*|vi\.mock\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(re)) {
    const spec = m[1] ?? '';
    const sdk = ALL_SDKS.find((s) => spec === s || spec.startsWith(`${s}/`));
    if (sdk !== undefined) found.add(sdk);
  }
  return [...found];
}

const NAME_COMPARISON =
  /(?:[!=]==?\s*['"](?:anthropic|openai|gemini|deepseek)['"])|(?:['"](?:anthropic|openai|gemini|deepseek)['"]\s*[!=]==?)|(?:case\s+['"](?:anthropic|openai|gemini|deepseek)['"])/;

function isTestFile(file: string): boolean {
  return (
    file.includes(`${sep}__tests__${sep}`) ||
    file.includes(`${sep}__integration__${sep}`) ||
    file.includes(`${sep}e2e${sep}`) ||
    /\.test\.[cm]?[jt]sx?$/.test(file)
  );
}

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
}

describe('AI provider isolation (TC-AI-PK-01)', () => {
  const files = workspaceFiles();

  it('TC-AI-PK-01 scans the workspace, adapters included', () => {
    expect(files.some((f) => f.startsWith(join(PROVIDERS, 'anthropic') + sep))).toBe(true);
    expect(files.some((f) => f.startsWith(join(PACKAGES, 'api', 'src') + sep))).toBe(true);
    expect(files.some((f) => f.startsWith(join(PACKAGES, 'worker', 'src') + sep))).toBe(true);
  });

  it('TC-AI-PK-01 no provider SDK import outside packages/ai/src/providers/<id>/', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sdks = importedSdks(readFileSync(file, 'utf8'));
      if (sdks.length === 0) continue;
      const rel = relative(PROVIDERS, file);
      const folder = rel.startsWith('..') || !rel.includes(sep) ? undefined : rel.split(sep)[0];
      const allowed = folder !== undefined ? (SDKS[folder] ?? []) : [];
      for (const sdk of sdks) {
        if (!allowed.includes(sdk)) offenders.push(`${relative(ROOT, file)} imports ${sdk}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('TC-AI-PK-01 no provider-name comparison outside the adapters and tests', () => {
    const offenders = files
      .filter((f) => !f.startsWith(PROVIDERS + sep) && !isTestFile(f))
      .filter((f) => NAME_COMPARISON.test(readFileSync(f, 'utf8')))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('TC-AI-PK-01 only @evtivity/ai depends on the provider SDKs, and the legacy SDK is gone', () => {
    const ai = readPackageJson(join(PACKAGES, 'ai'));
    expect(Object.keys(ai.dependencies ?? {})).toEqual(
      expect.arrayContaining(['@anthropic-ai/sdk', 'openai', '@google/genai']),
    );
    const offenders: string[] = [];
    for (const dir of [ROOT, ...readdirSync(PACKAGES).map((pkg) => join(PACKAGES, pkg))]) {
      if (!existsSync(join(dir, 'package.json'))) continue;
      const pkg = readPackageJson(dir);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const sdk of ALL_SDKS) {
        const allowed = pkg.name === '@evtivity/ai' && sdk !== '@google/generative-ai';
        if (deps[sdk] !== undefined && !allowed) offenders.push(`${pkg.name} lists ${sdk}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('TC-AI-PK-01 @evtivity/ai depends on no workspace package but @evtivity/lib', () => {
    const ai = readPackageJson(join(PACKAGES, 'ai'));
    const workspaceDeps = Object.keys({ ...ai.dependencies, ...ai.devDependencies }).filter((d) =>
      d.startsWith('@evtivity/'),
    );
    expect(workspaceDeps).toEqual(['@evtivity/lib']);
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
