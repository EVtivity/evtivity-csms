// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Copies the workspace manifests a Dockerfile installs from (package.json, package-lock.json and
// packages/*/package.json under <src>) to <dest> with every workspace version set to 0.0.0.
// The Dockerfiles run `npm ci` on <dest> and then copy the real manifests back, so a release,
// which changes only the version fields, keeps the cached dependency layer, while the image
// still carries the real versions. Nothing but the workspace version fields changes.
//
// Usage: node scripts/docker-dependency-manifests.mjs <src> <dest>
import fs from 'node:fs';
import { dirname, join } from 'node:path';

export const STRIPPED_VERSION = '0.0.0';

/** The workspace package directories (relative, such as packages/api) a lockfile names. */
function workspacePaths(lock) {
  return Object.keys(lock.packages ?? {}).filter(
    (k) => k !== '' && !k.includes('node_modules/') && lock.packages[k]?.link !== true,
  );
}

/** A lockfile with its own and every workspace version set to STRIPPED_VERSION. */
export function stripLock(lock) {
  const out = structuredClone(lock);
  if ('version' in out) out.version = STRIPPED_VERSION;
  if (out.packages?.['']) out.packages[''].version = STRIPPED_VERSION;
  for (const k of workspacePaths(out)) {
    if ('version' in out.packages[k]) out.packages[k].version = STRIPPED_VERSION;
  }
  return out;
}

/** A package.json with its version set to STRIPPED_VERSION. */
export function stripManifest(pkg) {
  return 'version' in pkg ? { ...pkg, version: STRIPPED_VERSION } : pkg;
}

function write(file, obj) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

export function copyStripped(src, dest) {
  const read = (rel) => JSON.parse(fs.readFileSync(join(src, rel), 'utf8'));
  write(join(dest, 'package.json'), stripManifest(read('package.json')));
  if (fs.existsSync(join(src, 'package-lock.json'))) {
    write(join(dest, 'package-lock.json'), stripLock(read('package-lock.json')));
  }
  const pkgs = join(src, 'packages');
  if (!fs.existsSync(pkgs)) return;
  for (const name of fs.readdirSync(pkgs).sort()) {
    const rel = join('packages', name, 'package.json');
    if (fs.existsSync(join(src, rel))) write(join(dest, rel), stripManifest(read(rel)));
  }
}

if (process.argv[1] && import.meta.filename === fs.realpathSync(process.argv[1])) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error('usage: node docker-dependency-manifests.mjs <src> <dest>');
    process.exit(2);
  }
  copyStripped(src, dest);
}
