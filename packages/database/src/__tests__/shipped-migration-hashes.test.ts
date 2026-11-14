// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Every migration file a stable release shipped is frozen: the runner decides
// pending by hash, so a changed file runs again on every install that applied
// it. packages/database/shipped-migrations.json records each one's SHA-256.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationHash } from '../../../../scripts/lib/migration-files.mjs';
import {
  recordShippedMigrations,
  shippedMigrationProblems,
  type MigrationJournal,
  type ShippedMigrations,
} from '../../../../scripts/lib/shipped-migrations.mjs';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const SHIPPED = JSON.parse(
  readFileSync(new URL('../../shipped-migrations.json', import.meta.url), 'utf8'),
) as ShippedMigrations;
const JOURNAL = JSON.parse(
  readFileSync(new URL('meta/_journal.json', MIGRATIONS_DIR), 'utf8'),
) as MigrationJournal;

function currentHash(tag: string): string | null {
  const file = new URL(`${tag}.sql`, MIGRATIONS_DIR);
  return existsSync(file) ? migrationHash(readFileSync(file, 'utf8')) : null;
}

describe('shipped migration hashes', () => {
  it('keeps every migration file of a released version byte for byte', () => {
    expect(shippedMigrationProblems(SHIPPED, JOURNAL, currentHash)).toEqual([]);
  });

  it('records every release up to v0.1.51, with its release files', () => {
    // 0487 (public PR 54) shipped with v0.1.50.
    expect(Object.keys(SHIPPED['v0.1.50'] ?? {})).toContain('0487_station_portal_listed');
    expect(SHIPPED['v0.1.51']).toEqual({
      '0488_release_0_1_51': expect.any(String),
      '0489_release_0_1_51_indexes': expect.any(String),
    });
    expect(Object.values(SHIPPED).flatMap((files) => Object.keys(files))).toHaveLength(244);
  });

  it('leaves only the files of the release being built unrecorded', () => {
    const recorded = new Set(Object.values(SHIPPED).flatMap((files) => Object.keys(files)));
    const unrecorded = JOURNAL.entries.map((e) => e.tag).filter((tag) => !recorded.has(tag));
    const versions = new Set(
      unrecorded.map((tag) =>
        /^\d{4}_release_(\d+)_(\d+)_(\d+)(?:_\w+)?$/.exec(tag)?.slice(1, 4).join('.'),
      ),
    );
    // One release in the making, newer than every recorded one: run
    // scripts/record-shipped-migrations.mjs after each stable tag.
    expect(versions.size).toBeLessThanOrEqual(1);
    const [building] = [...versions];
    if (building == null) return;
    const newest = Object.keys(SHIPPED).at(-1)?.slice(1) ?? '0.0.0';
    expect(building.localeCompare(newest, 'en', { numeric: true })).toBe(1);
  });
});

describe('shippedMigrationProblems', () => {
  const journal: MigrationJournal = {
    entries: [
      { idx: 0, tag: '0001_a' },
      { idx: 1, tag: '0002_b' },
      { idx: 2, tag: '0003_c' },
    ],
  };
  const shipped: ShippedMigrations = { 'v0.1.0': { '0001_a': 'h1' }, 'v0.1.1': { '0002_b': 'h2' } };
  const hashes: Record<string, string> = { '0001_a': 'h1', '0002_b': 'h2', '0003_c': 'h3' };
  const hashOf = (tag: string): string | null => hashes[tag] ?? null;

  it('passes the unchanged files and an unrecorded file after them', () => {
    expect(shippedMigrationProblems(shipped, journal, hashOf)).toEqual([]);
  });

  it('fails a shipped file whose bytes changed', () => {
    const problems = shippedMigrationProblems(shipped, journal, (tag) =>
      tag === '0002_b' ? 'changed' : hashOf(tag),
    );
    expect(problems).toEqual([expect.stringMatching(/^0002_b \(shipped in v0\.1\.1\): its bytes/)]);
  });

  it('fails a shipped file that is missing or left the journal', () => {
    const missing = shippedMigrationProblems(shipped, journal, (tag) =>
      tag === '0001_a' ? null : hashOf(tag),
    );
    expect(missing).toEqual(['0001_a (shipped in v0.1.0): the file is missing']);
    const left = shippedMigrationProblems(
      shipped,
      { entries: journal.entries.filter((e) => e.tag !== '0001_a') },
      hashOf,
    );
    expect(left).toEqual(['0001_a (shipped in v0.1.0): not in the journal']);
  });

  it('fails an unrecorded file ordered before a shipped one and a file listed twice', () => {
    const before = shippedMigrationProblems({ 'v0.1.1': { '0002_b': 'h2' } }, journal, hashOf);
    expect(before).toEqual(['0001_a: not shipped but ordered before a shipped migration']);
    const twice = shippedMigrationProblems(
      { ...shipped, 'v0.1.2': { '0001_a': 'h1' } },
      journal,
      hashOf,
    );
    expect(twice).toEqual(['0001_a: listed in v0.1.0 and v0.1.2']);
  });
});

describe('recordShippedMigrations', () => {
  const journal: MigrationJournal = {
    entries: [
      { idx: 0, tag: '0001_a' },
      { idx: 1, tag: '0002_b' },
    ],
  };
  const hashOf = (tag: string): string | null => `sha-${tag}`;

  it('records the files no release lists under the new version', () => {
    const next = recordShippedMigrations(
      { 'v0.1.0': { '0001_a': 'h1' } },
      journal,
      hashOf,
      'v0.1.1',
    );
    expect(next).toEqual({ 'v0.1.0': { '0001_a': 'h1' }, 'v0.1.1': { '0002_b': 'sha-0002_b' } });
  });

  it('refuses a prerelease tag, a recorded version and a release with no new file', () => {
    expect(() => recordShippedMigrations({}, journal, hashOf, 'v0.1.1-beta.1')).toThrow(/stable/);
    expect(() =>
      recordShippedMigrations({ 'v0.1.1': { '0001_a': 'h1' } }, journal, hashOf, 'v0.1.1'),
    ).toThrow(/already recorded/);
    expect(() =>
      recordShippedMigrations(
        { 'v0.1.0': { '0001_a': 'h1', '0002_b': 'h2' } },
        journal,
        hashOf,
        'v0.1.1',
      ),
    ).toThrow(/no new migration/);
  });
});
