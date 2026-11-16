// The migration baseline a squash writes at a minor version bump. The migration
// files first shipped before the previous minor release (X.(Y-1).0) are folded
// into one baseline file, the first journal entry; meta/baseline.json names the
// files it replaces and their hashes. Without that manifest nothing here changes
// how migrations run.
//
// An empty database runs the baseline like any file. A database that already
// recorded every replaced file, and the marker (the first file the upgrade
// release shipped), records the baseline as applied without running it. Any
// other database is older than the upgrade release and is refused before
// anything runs: it must upgrade to that release first.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const BASELINE_MANIFEST = 'baseline.json';

/** The manifest in <folder>/meta/baseline.json, null when there is none. */
export function readBaselineManifest(folder) {
  const file = path.join(folder, 'meta', BASELINE_MANIFEST);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The journal tag of the baseline that folds every file older than `foldBefore`. */
export function baselineTagFor(foldBefore) {
  return `0000_baseline_before_${foldBefore.replace(/\./g, '_')}`;
}

/** vX.Y.Z[-label] -> [X, Y, Z], null for anything else. */
export function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[a-z]+(?:\.\d+)?)?$/.exec(tag);
  return m == null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1, 0 or 1: stable versions compared by number. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x == null || y == null) throw new Error(`not a version: ${x == null ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The .0 release of the line just before the new line `tag` opens (X.Y.0): for a minor X.(Y-1).0,
 * for a major the newest line of major X-1 in `shipped` (the stable releases that shipped
 * migration files). Null when `tag` opens no line, is v0.2.0 (skipped by rule) or earlier, or the
 * line before is 0.1 (nothing older than v0.1.0 to fold).
 */
export function squashRequiredFor(tag, shipped) {
  const v = parseVersion(tag);
  if (v == null || v[2] !== 0) return null;
  if (v[0] === 0 && v[1] <= 2) return null;
  if (v[1] > 0) return `v${v[0]}.${v[1] - 1}.0`;
  const minors = Object.keys(shipped ?? {})
    .map(parseVersion)
    .filter((p) => p != null && p[0] === v[0] - 1)
    .map((p) => p[1]);
  if (minors.length === 0) {
    throw new Error(`${tag}: no release of major ${v[0] - 1} in the shipped map to fold before`);
  }
  const line = Math.max(...minors);
  if (v[0] - 1 === 0 && line <= 1) return null;
  return `v${v[0] - 1}.${line}.0`;
}

/**
 * The release whose older files the baseline of the new line `tag` folds: v0.3.0 folds every file
 * first shipped before v0.2.0, v1.0.0 after the 0.5 line every file before v0.5.0. Throws for a
 * tag that needs no baseline (a patch release, v0.2.0 and earlier).
 */
export function foldBeforeFor(tag, shipped) {
  const v = parseVersion(tag);
  if (v == null || v[2] !== 0) throw new Error(`${tag} is not the first release of a line (X.Y.0)`);
  const before = squashRequiredFor(tag, shipped);
  if (before == null) {
    throw new Error(`${tag}: v0.2.0 is skipped and earlier lines fold nothing (no baseline)`);
  }
  return before;
}

/**
 * What the runner does with the baseline, from the hashes the database recorded.
 * @returns {{ kind: 'none' } | { kind: 'run' } | { kind: 'mark' } | { kind: 'refuse', message: string }}
 */
export function baselineAction(manifest, appliedHashes) {
  if (manifest == null || appliedHashes.has(manifest.baseline.hash)) return { kind: 'none' };
  if (appliedHashes.size === 0) return { kind: 'run' };
  const replacedAll = Object.values(manifest.replaced).every((hash) => appliedHashes.has(hash));
  const atUpgrade = manifest.marker == null || appliedHashes.has(manifest.marker.hash);
  if (replacedAll && atUpgrade) return { kind: 'mark' };
  const from = manifest.upgradeFrom;
  const [x, y] = parseVersion(from) ?? [0, 0];
  return {
    kind: 'refuse',
    message:
      `this database is older than ${from}: upgrade to ${from} ` +
      `(or any later ${x}.${y}.x release) first, then to ${manifest.release}`,
  };
}

/**
 * Applies the baseline decision on a migrator session (`sql`, max: 1, under the
 * migration lock). Records the baseline hash with its journal `when` for a
 * database at the upgrade release; throws for an older one. Returns the action.
 */
export async function reconcileBaseline(sql, manifest, appliedHashes) {
  const action = baselineAction(manifest, appliedHashes);
  if (action.kind === 'refuse') throw new Error(action.message);
  if (action.kind === 'mark') {
    await sql`
      INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
      VALUES (${manifest.baseline.hash}, ${manifest.baseline.when})
    `;
    appliedHashes.add(manifest.baseline.hash);
  }
  return action;
}

/**
 * Problems between the manifest, the journal and the files: the baseline must be
 * the first entry with the manifest hash and `when`, no replaced file may still
 * be in the journal, and the marker must be a journal file with its hash.
 */
export function baselineManifestProblems(manifest, journal, hashOf) {
  const problems = [];
  const tag = manifest.baseline.tag;
  const first = journal.entries[0];
  if (first?.tag !== tag) problems.push(`${tag}: the baseline must be the first journal entry`);
  else if (first.when !== manifest.baseline.when) {
    problems.push(`${tag}: its journal when differs from the manifest`);
  }
  const current = hashOf(tag);
  if (current == null) problems.push(`${tag}: the baseline file is missing`);
  else if (current !== manifest.baseline.hash) {
    problems.push(`${tag}: its bytes differ from the manifest hash (run the squash again)`);
  }
  const journalTags = new Set(journal.entries.map((e) => e.tag));
  for (const replaced of Object.keys(manifest.replaced)) {
    if (journalTags.has(replaced)) {
      problems.push(`${replaced}: folded into the baseline but still in the journal`);
    }
  }
  if (manifest.marker != null) {
    if (!journalTags.has(manifest.marker.tag)) {
      problems.push(`${manifest.marker.tag}: the marker file is not in the journal`);
    } else if (hashOf(manifest.marker.tag) !== manifest.marker.hash) {
      problems.push(`${manifest.marker.tag}: the marker file differs from the manifest hash`);
    }
  }
  return problems;
}
