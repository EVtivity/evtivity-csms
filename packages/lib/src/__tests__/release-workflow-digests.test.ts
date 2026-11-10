// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The release workflow uploads one digest artifact per image and platform and
// joins the two of each image. The download pattern of an image must match
// only its own artifacts: `digests-ocpi-*` also matched the ocpi-simulator
// digests and failed the v0.1.51-beta.1 publish with 4 digests for ocpi.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');

function one(re: RegExp, what: string): string {
  const m = re.exec(WORKFLOW);
  if (m?.[1] === undefined) throw new Error(`release.yml has no ${what}`);
  return m[1].trim();
}

const IMAGES = one(/^\s+image: \[([^\]]+)\]$/m, 'publish image matrix')
  .split(',')
  .map((s) => s.trim());
const ARCHES = ['amd64', 'arm64'];
const NAME = one(/^\s+name: (digests.*)$/m, 'digest artifact name');
const PATTERN = one(/^\s+pattern: (digests.*)$/m, 'digest download pattern');

function artifactName(image: string, arch: string): string {
  return NAME.replace('${{ matrix.service.image }}', image).replace(
    '${{ matrix.arch.name }}',
    arch,
  );
}

function patternRegex(image: string): RegExp {
  const glob = PATTERN.replace('${{ matrix.image }}', image);
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

describe('release workflow digest artifacts', () => {
  it('lists the images of the publish matrix', () => {
    expect(IMAGES).toContain('ocpi');
    expect(IMAGES).toContain('ocpi-simulator');
  });

  it.each(IMAGES)('downloads exactly the two platform digests of %s', (image) => {
    const all = IMAGES.flatMap((img) => ARCHES.map((arch) => artifactName(img, arch)));
    const matched = all.filter((name) => patternRegex(image).test(name));
    expect(matched).toEqual(ARCHES.map((arch) => artifactName(image, arch)));
  });
});
