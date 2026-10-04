// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

// v-prefix optional, patch optional, prerelease optional, build metadata ignored.
const VERSION_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_RE = /^\d+$/;

export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_RE.exec(value.trim());
  if (match == null) return null;
  const prerelease = match[4] == null ? [] : match[4].split('.');
  if (prerelease.some((id) => id === '')) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')],
    prerelease,
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNum = NUMERIC_RE.test(a);
  const bNum = NUMERIC_RE.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  // Numeric identifiers have lower precedence than alphanumeric ones.
  if (aNum) return -1;
  if (bNum) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Semver 2.0.0 precedence (section 11): a prerelease ranks below its release,
// so 0.1.38-beta.1 < 0.1.38. Returns -1, 0, or 1.
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const aId = a.prerelease[i];
    const bId = b.prerelease[i];
    if (aId == null) return -1;
    if (bId == null) return 1;
    const diff = compareIdentifiers(aId, bId);
    if (diff !== 0) return diff;
  }
  return 0;
}

// True when `latest` has higher semver precedence than `current`. False when
// either value does not parse, so a malformed version never triggers a notice.
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (a == null || b == null) return false;
  return compareVersions(a, b) > 0;
}
