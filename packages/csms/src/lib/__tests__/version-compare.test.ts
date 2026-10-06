// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion, parseVersion } from '../version-compare';

function cmp(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa == null || pb == null) throw new Error(`unparsable: ${a} ${b}`);
  return compareVersions(pa, pb);
}

describe('parseVersion', () => {
  it('parses stable and prerelease versions with or without v', () => {
    expect(parseVersion('v0.1.38')).toEqual({ core: [0, 1, 38], prerelease: [] });
    expect(parseVersion('0.1.38-beta.1')).toEqual({
      core: [0, 1, 38],
      prerelease: ['beta', '1'],
    });
    expect(parseVersion(' v1.2 ')).toEqual({ core: [1, 2, 0], prerelease: [] });
    expect(parseVersion('1.2.3-rc.1+build.5')).toEqual({
      core: [1, 2, 3],
      prerelease: ['rc', '1'],
    });
  });

  it('rejects malformed values', () => {
    for (const value of ['', 'v', 'latest', '1', '1.2.3.4', '1.2.3-', '1.2.3-beta..1', '<html>']) {
      expect(parseVersion(value)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders the semver 2.0.0 precedence example', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      expect(cmp(ordered[i] ?? '', ordered[i + 1] ?? '')).toBe(-1);
      expect(cmp(ordered[i + 1] ?? '', ordered[i] ?? '')).toBe(1);
    }
  });

  it('compares core numbers numerically', () => {
    expect(cmp('0.1.10', '0.1.9')).toBe(1);
    expect(cmp('1.0.0', '0.99.99')).toBe(1);
    expect(cmp('v0.1.38', '0.1.38')).toBe(0);
    expect(cmp('0.1.38-beta.2', '0.1.38-beta.10')).toBe(-1);
  });
});

describe('isNewerVersion', () => {
  it('tells a prerelease install about its stable release', () => {
    expect(isNewerVersion('v0.1.38', '0.1.38-beta.1')).toBe(true);
    expect(isNewerVersion('v0.1.38', '0.1.38-alpha.3')).toBe(true);
    expect(isNewerVersion('v0.1.38', '0.1.38-rc.1')).toBe(true);
  });

  it('does not offer an older stable release to a newer prerelease install', () => {
    expect(isNewerVersion('v0.1.37', '0.1.38-beta.1')).toBe(false);
  });

  it('handles stable installs', () => {
    expect(isNewerVersion('v0.1.38', '0.1.37')).toBe(true);
    expect(isNewerVersion('v0.1.38', '0.1.38')).toBe(false);
    expect(isNewerVersion('v0.1.37', '0.1.38')).toBe(false);
    expect(isNewerVersion('v0.1.10', '0.1.9')).toBe(true);
  });

  it('is false when either value is malformed', () => {
    expect(isNewerVersion('not found', '0.1.38')).toBe(false);
    expect(isNewerVersion('v0.1.38', 'unknown')).toBe(false);
  });
});
