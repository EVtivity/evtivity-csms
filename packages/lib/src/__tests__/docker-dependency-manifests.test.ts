// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Dockerfiles install their dependencies from manifests whose workspace versions are set to
// 0.0.0 (scripts/docker-dependency-manifests.mjs), so a release, which changes only the version
// fields, keeps the cached npm ci layer; the real manifests are copied back after each install.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { copyStripped, stripLock } from '../../../../scripts/docker-dependency-manifests.mjs';

const ROOT = resolve(import.meta.dirname, '../../../..');
const IMAGES = readdirSync(join(ROOT, 'packages')).filter((pkg) =>
  existsSync(join(ROOT, 'packages', pkg, 'Dockerfile')),
);
const dockerfile = (pkg: string): string =>
  readFileSync(join(ROOT, 'packages', pkg, 'Dockerfile'), 'utf8');

interface Lock {
  version?: string;
  packages: Record<string, { version?: string; link?: boolean; resolved?: string }>;
}

describe('docker dependency manifests', () => {
  it('sets the root, lockfile and workspace versions to 0.0.0 and nothing else', () => {
    const lock: Lock = {
      version: '0.1.50',
      packages: {
        '': { version: '0.1.50' },
        'packages/api': { version: '0.1.50' },
        'node_modules/@evtivity/api': { resolved: 'packages/api', link: true },
        'node_modules/zod': { version: '4.1.0' },
        'packages/csms/node_modules/react-router': { version: '8.4.0' },
      },
    };
    const out = stripLock(lock);
    expect(out.version).toBe('0.0.0');
    expect(out.packages['']?.version).toBe('0.0.0');
    expect(out.packages['packages/api']?.version).toBe('0.0.0');
    expect(out.packages['node_modules/zod']?.version).toBe('4.1.0');
    expect(out.packages['packages/csms/node_modules/react-router']?.version).toBe('8.4.0');
    expect(out.packages['node_modules/@evtivity/api']).toEqual(
      lock.packages['node_modules/@evtivity/api'],
    );
    expect(lock.version).toBe('0.1.50');
  });

  it('strips every workspace version of this workspace and keeps its lockfile entries', () => {
    const a = mkdtempSync(join(tmpdir(), 'ddm-a-'));
    try {
      copyStripped(ROOT, a);
      const root = JSON.parse(readFileSync(join(a, 'package.json'), 'utf8')) as {
        version: string;
      };
      expect(root.version).toBe('0.0.0');
      const lock = JSON.parse(readFileSync(join(a, 'package-lock.json'), 'utf8')) as Lock;
      for (const [k, v] of Object.entries(lock.packages)) {
        if (/^packages\/[a-z0-9-]+$/.test(k)) expect(v.version, k).toBe('0.0.0');
      }
      const real = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as Lock;
      expect(Object.keys(lock.packages)).toEqual(Object.keys(real.packages));
      for (const pkg of IMAGES) {
        const m = JSON.parse(readFileSync(join(a, 'packages', pkg, 'package.json'), 'utf8')) as {
          version: string;
        };
        expect(m.version, pkg).toBe('0.0.0');
      }
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });

  it.each(IMAGES)(
    '%s installs from the stripped manifests and copies the real ones back',
    (pkg) => {
      const text = dockerfile(pkg);
      if (!/^RUN npm ci/m.test(text)) return; // an image without an npm install
      expect(text).toMatch(/^FROM --platform=\$BUILDPLATFORM \S+ AS manifests$/m);
      expect(text).toContain('RUN node /tmp/docker-dependency-manifests.mjs /real /app\n');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!line.startsWith('RUN npm ci')) return;
        const before = lines.slice(0, i).filter((l) => l.trim() !== '');
        expect(before.at(-1), `${pkg} line ${String(i + 1)}`).toBe(
          'COPY --from=manifests /app/ ./',
        );
        expect(lines[i + 1], `${pkg} line ${String(i + 2)}`).toBe(
          'COPY --from=manifests /real/ ./',
        );
      });
      // No stage installs from manifests it copied itself, which a release would invalidate.
      for (const stage of text.split(/^FROM /m).slice(1)) {
        if (!/^RUN npm ci/m.test(stage)) continue;
        expect(stage, pkg).not.toMatch(/^COPY package\.json package-lock\.json/m);
      }
    },
  );
});
