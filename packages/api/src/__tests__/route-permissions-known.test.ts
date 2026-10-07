// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { permissionCatalog } from '@evtivity/lib';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith('__') ? [] : sourceFiles(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

// authorize('x', ...), requestHasPermission(req, 'x') and entity-neighbors `permission: 'x'`.
// authorize is variadic, so every quoted argument counts.
const PERMISSION_LITERAL =
  /authorize\(([^)]*)\)|requestHasPermission\(\s*\w+\s*,\s*'([^']+)'\s*\)|permission:\s*'([^']+)'/g;

function permissionLiteralsIn(source: string): string[] {
  return [...source.matchAll(PERMISSION_LITERAL)].flatMap((m) => {
    if (m[1] != null) return [...m[1].matchAll(/'([^']+)'/g)].map((a) => a[1] ?? '');
    return [m[2] ?? m[3] ?? ''];
  });
}

function permissionLiterals(): { file: string; permission: string }[] {
  return sourceFiles(SRC).flatMap((file) =>
    permissionLiteralsIn(readFileSync(file, 'utf8')).map((permission) => ({
      file: path.relative(SRC, file),
      permission,
    })),
  );
}

describe('route permissions', () => {
  const literals = permissionLiterals();

  it('reads every argument of a multi-permission authorize call', () => {
    expect(
      permissionLiteralsIn(
        "authorize('stations:read', 'nope:write') authorize(target.permission) " +
          "requestHasPermission(request, 'sites:read') permission: 'drivers:read'",
      ),
    ).toEqual(['stations:read', 'nope:write', 'sites:read', 'drivers:read']);
  });

  it('finds the permission guards of the routes', () => {
    // About 475 today: a scanner that stops matching fails here instead of passing empty.
    expect(literals.filter((l) => l.file.startsWith(`routes${path.sep}`)).length).toBeGreaterThan(
      300,
    );
  });

  it('guards every route with a permission from the catalog', () => {
    const unknown = literals.filter((l) => !permissionCatalog.isKnown(l.permission));
    expect(unknown).toEqual([]);
  });
});
