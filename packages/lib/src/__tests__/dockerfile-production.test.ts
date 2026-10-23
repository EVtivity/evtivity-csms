// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Production image rules: the service images run with NODE_ENV=production, so
// an install outside Helm and CDK does not get the development relaxations;
// every base image is pinned by digest; the build context leaves local secrets
// out; the migrate image runs as node; the source label names the CSMS repository.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');

/** Every package with a production Dockerfile. */
const IMAGES = readdirSync(join(ROOT, 'packages')).filter((pkg) =>
  existsSync(join(ROOT, 'packages', pkg, 'Dockerfile')),
);

function dockerfile(pkg: string): string {
  return readFileSync(join(ROOT, 'packages', pkg, 'Dockerfile'), 'utf8');
}

/** The lines of the last stage (the runtime image). */
function runtimeStage(text: string): string {
  const stages = text.split(/^FROM /m);
  return stages[stages.length - 1] ?? '';
}

describe('production Dockerfiles', () => {
  it.each(['api', 'ocpp', 'ocpi', 'worker'])(
    '%s runs with NODE_ENV=production in its runtime stage',
    (pkg) => {
      expect(runtimeStage(dockerfile(pkg))).toMatch(/^ENV NODE_ENV=production$/m);
    },
  );

  it.each(IMAGES)('%s pins every external base image by digest', (pkg) => {
    const bases = dockerfile(pkg)
      .split('\n')
      .filter((line) => line.startsWith('FROM '))
      .map((line) => line.replace(/^FROM (--platform=\S+ )?/, '').split(' ')[0] ?? '')
      .filter((image) => !['deps', 'build'].includes(image));
    expect(bases.length).toBeGreaterThan(0);
    for (const image of bases) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it.each(IMAGES)('%s names the CSMS repository as its source', (pkg) => {
    expect(dockerfile(pkg)).toContain(
      'LABEL org.opencontainers.image.source="https://github.com/EVtivity/evtivity-csms"\n',
    );
  });

  it('the database image runs migrations as the node user', () => {
    expect(runtimeStage(dockerfile('database'))).toMatch(/^USER node$/m);
  });

  it('keeps local env files, seed configs and test certificates out of the build context', () => {
    const ignored = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n');
    // A package-level env file too.
    for (const pattern of [
      '**/.env',
      '**/.env.*',
      '**/seed.config.json',
      'packages/css/test-certs/',
    ]) {
      expect(ignored).toContain(pattern);
    }
  });
});
