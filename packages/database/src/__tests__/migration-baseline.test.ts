// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The migration baseline a squash writes at a minor version bump: how the
// runner treats it and how the journal checks read its manifest.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  baselineAction,
  baselineManifestProblems,
  baselineTagFor,
  foldBeforeFor,
  readBaselineManifest,
  squashRequiredFor,
  type BaselineManifest,
} from '../../../../scripts/lib/migration-baseline.mjs';

const manifest: BaselineManifest = {
  baseline: { tag: '0000_baseline_before_v0_2_0', hash: 'hb', when: 30 },
  release: 'v0.3.0',
  upgradeFrom: 'v0.2.0',
  marker: { tag: '0004_d', hash: 'h4' },
  lastReplaced: { tag: '0003_c', hash: 'h3', when: 30 },
  replaced: { '0001_a': 'h1', '0002_b': 'h2', '0003_c': 'h3' },
  pgDumpMajor: 17,
  runtimeValues: [],
};

describe('baselineAction', () => {
  it('does nothing without a manifest or once the baseline is recorded', () => {
    expect(baselineAction(null, new Set(['h1']))).toEqual({ kind: 'none' });
    expect(baselineAction(manifest, new Set(['hb', 'h4']))).toEqual({ kind: 'none' });
  });

  it('runs the baseline on an empty database', () => {
    expect(baselineAction(manifest, new Set())).toEqual({ kind: 'run' });
  });

  it('marks the baseline applied on a database at the upgrade release', () => {
    expect(baselineAction(manifest, new Set(['h1', 'h2', 'h3', 'h4']))).toEqual({ kind: 'mark' });
  });

  it('marks it without a marker when the upgrade release shipped no file', () => {
    const noMarker = { ...manifest, marker: null };
    expect(baselineAction(noMarker, new Set(['h1', 'h2', 'h3']))).toEqual({ kind: 'mark' });
  });

  it('refuses a database older than the upgrade release', () => {
    const older = baselineAction(manifest, new Set(['h1', 'h2', 'h3']));
    expect(older).toEqual({
      kind: 'refuse',
      message:
        'this database is older than v0.2.0: upgrade to v0.2.0 (or any later 0.2.x release) first, then to v0.3.0',
    });
    expect(baselineAction(manifest, new Set(['h1', 'h4']))).toMatchObject({ kind: 'refuse' });
  });
});

const SHIPPED_LINES = { 'v0.4.0': {}, 'v0.5.0': {}, 'v0.5.3': {}, 'v1.2.1': {} };

describe('foldBeforeFor', () => {
  it('folds the files older than the .0 release of the line before', () => {
    expect(foldBeforeFor('v0.3.0', {})).toBe('v0.2.0');
    expect(foldBeforeFor('0.4.0-beta.1', {})).toBe('v0.3.0');
    expect(foldBeforeFor('v1.0.0', SHIPPED_LINES)).toBe('v0.5.0');
    expect(foldBeforeFor('v2.0.0-alpha.1', SHIPPED_LINES)).toBe('v1.2.0');
  });

  it('refuses v0.2.0, a patch release, an earlier minor and an unknown previous major', () => {
    expect(() => foldBeforeFor('v0.2.0', {})).toThrow(/v0\.2\.0 is skipped/);
    expect(() => foldBeforeFor('v0.3.1', {})).toThrow(/not the first release/);
    expect(() => foldBeforeFor('v0.1.0', {})).toThrow(/skipped/);
    expect(() => foldBeforeFor('v3.0.0', SHIPPED_LINES)).toThrow(/no release of major 2/);
  });
});

describe('squashRequiredFor', () => {
  it('asks for the baseline of the first release of a new line from v0.3.0 on', () => {
    expect(squashRequiredFor('v0.3.0-alpha.1', {})).toBe('v0.2.0');
    expect(squashRequiredFor('v0.3.0-beta.4', {})).toBe('v0.2.0');
    expect(squashRequiredFor('v0.3.0', {})).toBe('v0.2.0');
    expect(squashRequiredFor('v0.10.0', {})).toBe('v0.9.0');
    expect(squashRequiredFor('v1.0.0-beta.1', SHIPPED_LINES)).toBe('v0.5.0');
    expect(squashRequiredFor('v1.3.0', SHIPPED_LINES)).toBe('v1.2.0');
  });

  it('never asks for v0.2.x, a patch release, a v0.1.x release or a major after the 0.1 line', () => {
    for (const tag of [
      'v0.2.0',
      'v0.2.0-beta.1',
      'v0.2.3',
      'v0.3.1',
      'v0.1.52',
      'v0.1.0',
      'v1.0.1',
    ]) {
      expect(squashRequiredFor(tag, SHIPPED_LINES)).toBeNull();
    }
    expect(squashRequiredFor('v1.0.0', { 'v0.1.52': {} })).toBeNull();
  });
});

describe('baselineTagFor', () => {
  it('names the baseline after the release it folds before', () => {
    expect(baselineTagFor('v0.2.0')).toBe('0000_baseline_before_v0_2_0');
  });
});

describe('baselineManifestProblems', () => {
  const journal = {
    entries: [
      { idx: 0, tag: '0000_baseline_before_v0_2_0', when: 30 },
      { idx: 1, tag: '0004_d', when: 40 },
    ],
  };
  const hashes: Record<string, string> = { '0000_baseline_before_v0_2_0': 'hb', '0004_d': 'h4' };
  const hashOf = (tag: string): string | null => hashes[tag] ?? null;

  it('passes a baseline first in the journal with its folded files gone', () => {
    expect(baselineManifestProblems(manifest, journal, hashOf)).toEqual([]);
  });

  it('fails a baseline that is not first, changed or still has a folded file', () => {
    const notFirst = { entries: [journal.entries[1]!, { ...journal.entries[0]!, idx: 1 }] };
    expect(baselineManifestProblems(manifest, notFirst, hashOf)).toContain(
      '0000_baseline_before_v0_2_0: the baseline must be the first journal entry',
    );
    expect(
      baselineManifestProblems(manifest, journal, (t) => (t === '0004_d' ? 'h4' : 'x')),
    ).toContain(
      '0000_baseline_before_v0_2_0: its bytes differ from the manifest hash (run the squash again)',
    );
    const kept = { entries: [...journal.entries, { idx: 2, tag: '0002_b', when: 50 }] };
    expect(baselineManifestProblems(manifest, kept, (t) => hashes[t] ?? 'h2')).toContain(
      '0002_b: folded into the baseline but still in the journal',
    );
  });

  it('fails a marker that is missing or changed', () => {
    expect(
      baselineManifestProblems(manifest, journal, (t) => (t === '0004_d' ? 'x' : 'hb')),
    ).toContain('0004_d: the marker file differs from the manifest hash');
  });
});

describe('readBaselineManifest', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir != null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reads meta/baseline.json and returns null without it', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'baseline-'));
    mkdirSync(path.join(dir, 'meta'));
    expect(readBaselineManifest(dir)).toBeNull();
    writeFileSync(path.join(dir, 'meta', 'baseline.json'), JSON.stringify(manifest));
    expect(readBaselineManifest(dir)).toEqual(manifest);
  });
});
