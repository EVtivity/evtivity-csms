// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Keeps the Dockerfiles in lockstep with the workspace graph. A workspace package
// that a `tsc -b` target references, or that a dev image imports at runtime, must
// be copied into the image (and built when its exports point at dist/). Otherwise
// the image fails to build (TS6053) or the service fails at import time, which only
// a full `docker compose build` shows.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const PACKAGES = join(ROOT, 'packages');

const workspaces = readdirSync(PACKAGES).filter((d) =>
  existsSync(join(PACKAGES, d, 'package.json')),
);

function tsReferences(pkg: string): string[] {
  const file = join(PACKAGES, pkg, 'tsconfig.json');
  if (!existsSync(file)) return [];
  const config = JSON.parse(readFileSync(file, 'utf8')) as {
    references?: { path: string }[];
  };
  return (config.references ?? []).map((r) => r.path.replace(/^\.\.\//, ''));
}

function closure(roots: string[], next: (pkg: string) => string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const pkg = stack.pop();
    if (pkg == null || seen.has(pkg)) continue;
    seen.add(pkg);
    stack.push(...next(pkg));
  }
  return seen;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === '__integration__' || entry === 'generated') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const runtimeImportCache = new Map<string, string[]>();
// Workspace packages a package imports at runtime (type-only imports excluded).
function runtimeImports(pkg: string): string[] {
  const cached = runtimeImportCache.get(pkg);
  if (cached != null) return cached;
  const src = join(PACKAGES, pkg, 'src');
  const found = new Set<string>();
  if (existsSync(src)) {
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      const re = /^\s*(import|export)\s+(?!type\s)[^;]*?from\s+'@evtivity\/([a-z0-9-]+)/gm;
      for (const m of text.matchAll(re)) {
        const name = m[2];
        if (name != null && name !== pkg && workspaces.includes(name)) found.add(name);
      }
      for (const m of text.matchAll(/import\(\s*'@evtivity\/([a-z0-9-]+)/g)) {
        const name = m[1];
        if (name != null && name !== pkg && workspaces.includes(name)) found.add(name);
      }
    }
  }
  const result = [...found];
  runtimeImportCache.set(pkg, result);
  return result;
}

function exportsDist(pkg: string): boolean {
  const json = readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8');
  return /"default":\s*"\.\/dist\//.test(json) || /"main":\s*"dist\//.test(json);
}

interface Stage {
  copiedSources: Set<string>;
  tscTargets: string[];
  missingBeforeTsc: string[];
  entry: string | null;
}

// Last stage of a Dockerfile: the source COPY lines, the tsc -b targets, and the CMD entry package.
function parseLastStage(text: string): Stage {
  const stage: Stage = {
    copiedSources: new Set(),
    tscTargets: [],
    missingBeforeTsc: [],
    entry: null,
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^FROM\s/i.test(line)) {
      stage.copiedSources = new Set();
      stage.tscTargets = [];
      stage.missingBeforeTsc = [];
      stage.entry = null;
      continue;
    }
    const copy = /^COPY\s+(?:--from=\S+\s+)?packages\/([a-z0-9-]+)\/\s/.exec(line);
    if (copy?.[1] != null) stage.copiedSources.add(copy[1]);
    const tsc = /^RUN\s+npx tsc -b(?:\s+--force)?\s+(.+)$/.exec(line);
    if (tsc?.[1] != null) {
      const targets = [...tsc[1].matchAll(/packages\/([a-z0-9-]+)/g)].map((m) => m[1] ?? '');
      stage.tscTargets.push(...targets);
      for (const pkg of closure(targets, tsReferences)) {
        if (!stage.copiedSources.has(pkg)) stage.missingBeforeTsc.push(pkg);
      }
    }
    const cmd = /^CMD\s.*packages\/([a-z0-9-]+)\/src\//.exec(line);
    if (cmd?.[1] != null) stage.entry = cmd[1];
  }
  return stage;
}

const dockerfiles = workspaces.flatMap((pkg) =>
  ['Dockerfile', 'Dockerfile.dev']
    .map((name) => join('packages', pkg, name))
    .filter((rel) => existsSync(join(ROOT, rel))),
);

describe('Dockerfiles and the workspace graph', () => {
  it('finds the Dockerfiles', () => {
    expect(dockerfiles.length).toBeGreaterThan(10);
  });

  it.each(dockerfiles)('%s copies every project its tsc -b targets reference', (rel) => {
    const stage = parseLastStage(readFileSync(join(ROOT, rel), 'utf8'));
    expect(stage.missingBeforeTsc).toEqual([]);
  });

  it.each(dockerfiles.filter((rel) => rel.endsWith('.dev')))(
    '%s copies and builds every package its service imports at runtime',
    (rel) => {
      const stage = parseLastStage(readFileSync(join(ROOT, rel), 'utf8'));
      if (stage.entry == null) return;
      const built = closure(stage.tscTargets, tsReferences);
      const needed = [...closure([stage.entry], runtimeImports)].filter((p) => p !== stage.entry);
      const notCopied = needed.filter((p) => !stage.copiedSources.has(p));
      const notBuilt = needed.filter((p) => exportsDist(p) && !built.has(p));
      expect({ notCopied, notBuilt }).toEqual({ notCopied: [], notBuilt: [] });
    },
  );
});
