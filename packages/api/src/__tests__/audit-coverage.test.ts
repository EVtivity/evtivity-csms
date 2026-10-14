// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Coverage guard for the per-entity audit logs: every write route (POST, PUT,
// PATCH, DELETE) of the operator API and the driver portal is either audited
// or allowlisted with a reason.
// A new write route fails here until it is classified in
// helpers/audit-coverage.ts, and an entry for a route that no longer exists
// fails as stale.
//
// For an audited entry the guard also proves the call statically: the route
// registration calls an audit helper, or the entry's `service` file does and
// the route file imports it. The per-route unit and integration tests prove
// the rows themselves.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_COVERAGE, type AuditCoverage } from './helpers/audit-coverage.js';
import { SRC, scanRoutes, type RouteRegistration } from './helpers/route-scan.js';

const PACKAGES = path.resolve(SRC, '../..');
const WRITE = /^(POST|PUT|PATCH|DELETE) /;
// A call that writes an audit row: writeAudit, writeReservationAudit,
// writeInvoiceSentAudit, recordCommandAudit, auditSettingChanges, a
// *AuditLog table. getAuditActor alone does not count.
const AUDIT_CALL =
  /\bwrite\w*Audit\w*\s*\(|\brecord\w*Audit\w*\s*\(|\baudit[A-Z]\w*\s*\(|\b\w+AuditLog\b/;

const SCHEMA = readFileSync(path.join(PACKAGES, 'database/src/schema/audit.ts'), 'utf8');

function auditTableKeys(source: string): Set<string> {
  const block = /export const AUDIT_TABLES = \{([^}]*)\}/.exec(source)?.[1] ?? '';
  return new Set([...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1] ?? ''));
}

/**
 * The source file of a package.json `exports` entry: a path, or its
 * import/types/default condition. `types` comes before `default`, which
 * names the built `dist/` file that a checkout without a build lacks.
 */
function exportTarget(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry == null || typeof entry !== 'object') return null;
  const conditions = entry as Record<string, unknown>;
  return (
    exportTarget(conditions['import']) ??
    exportTarget(conditions['types']) ??
    exportTarget(conditions['default'])
  );
}

/** The file an import specifier of `fromFile` resolves to, relative to packages/. */
function resolveImport(fromFile: string, spec: string): string | null {
  const candidates: string[] = [];
  if (spec.startsWith('.')) {
    const base = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '');
    candidates.push(`${base}.ts`, path.join(base, 'index.ts'));
  } else {
    const match = /^@evtivity\/([\w-]+)(?:\/(.+))?$/.exec(spec);
    if (match == null) return null;
    const pkg = match[1] ?? '';
    const sub = match[2];
    const pkgJson = JSON.parse(readFileSync(path.join(PACKAGES, pkg, 'package.json'), 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    const target = exportTarget(pkgJson.exports?.[sub == null ? '.' : `./${sub}`]);
    if (target != null) candidates.push(path.join(PACKAGES, pkg, target));
    if (sub != null) candidates.push(path.join(PACKAGES, pkg, 'src', `${sub}.ts`));
  }
  const found = candidates.find((c) => existsSync(c));
  return found == null ? null : path.relative(PACKAGES, found);
}

/** Every file a source file imports or re-exports from, relative to packages/. */
function fromSpecifiers(absFile: string): Set<string> {
  const source = readFileSync(absFile, 'utf8');
  const out = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
    const resolved = resolveImport(absFile, match[1] ?? '');
    if (resolved != null) out.add(resolved);
  }
  return out;
}

/**
 * Every file a route file imports, relative to packages/. A shared package's
 * entry point (`<pkg>/src/index.ts`, such as `@evtivity/payments`) counts with
 * the files it re-exports, so a service behind the package entry is linked.
 */
function importsOf(routeFile: string): Set<string> {
  const out = fromSpecifiers(path.join(SRC, routeFile));
  for (const file of [...out]) {
    if (!/^[\w-]+\/src\/index\.ts$/.test(file)) continue;
    for (const reexported of fromSpecifiers(path.join(PACKAGES, file))) out.add(reexported);
  }
  return out;
}

function targetsOf(entry: AuditCoverage): readonly string[] {
  if ('audited' in entry)
    return typeof entry.audited === 'string' ? [entry.audited] : entry.audited;
  return [];
}

describe('audit coverage', () => {
  const registrations = new Map<string, RouteRegistration[]>();
  const { routes, portal, unparsed } = scanRoutes(registrations);
  const writes = [...routes, ...portal].filter((r) => WRITE.test(r));
  const entries = Object.entries(AUDIT_COVERAGE);
  const tables = auditTableKeys(SCHEMA);

  it('finds the operator and portal write routes', () => {
    // About 350 today: a scanner that stops matching fails here instead of passing empty.
    expect(writes.length).toBeGreaterThan(300);
    expect(writes.filter((r) => r.includes(' /portal/')).length).toBeGreaterThan(40);
    expect(unparsed).toEqual([]);
    expect(tables.size).toBeGreaterThan(30);
  });

  it('classifies every write route', () => {
    expect(writes.filter((r) => AUDIT_COVERAGE[r] == null)).toEqual([]);
  });

  it('lists no route that does not exist or is not a write', () => {
    const known = new Set(writes);
    expect(entries.map(([route]) => route).filter((r) => !known.has(r))).toEqual([]);
  });

  it('gives every allowlisted route a reason', () => {
    const vague = entries.filter(([, e]) => 'allow' in e && e.allow.trim().length < 8);
    expect(vague.map(([route]) => route)).toEqual([]);
  });

  it('names an audit table for every audited entry', () => {
    const problems = entries.flatMap(([route, e]) => {
      const targets = targetsOf(e);
      if ('allow' in e) return [];
      if (targets.length === 0) return [`${route}: no target`];
      return targets.filter((t) => !tables.has(t)).map((t) => `${route}: unknown target ${t}`);
    });
    expect(problems).toEqual([]);
  });

  it('proves every audited route calls an audit helper, directly or through its service', () => {
    const problems: string[] = [];
    for (const [route, e] of entries) {
      if (!('audited' in e)) continue;
      const regs = registrations.get(route) ?? [];
      if (e.service == null) {
        if (!regs.some((r) => AUDIT_CALL.test(r.text))) {
          problems.push(`${route}: no audit call in the handler, name its service`);
        }
        continue;
      }
      const servicePath = path.join(PACKAGES, e.service);
      if (!existsSync(servicePath)) {
        problems.push(`${route}: service ${e.service} does not exist`);
        continue;
      }
      if (!AUDIT_CALL.test(readFileSync(servicePath, 'utf8'))) {
        problems.push(`${route}: service ${e.service} writes no audit row`);
      }
      const linked = regs.some(
        (r) => path.join('api/src', r.file) === e.service || importsOf(r.file).has(e.service ?? ''),
      );
      if (!linked) problems.push(`${route}: route file does not import ${e.service}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('import resolution', () => {
  it('resolves relative and workspace package imports', () => {
    const tokens = importsOf(path.join('routes', 'tokens.ts'));
    expect(tokens.has('api/src/services/token.service.ts')).toBe(true);
    const reservations = importsOf(path.join('routes', 'reservations.ts'));
    expect(reservations.has('services/src/reservation.service.ts')).toBe(true);
  });

  it('resolves a package entry from its source and follows its re-exports', () => {
    const payments = importsOf(path.join('routes', 'payments.ts'));
    expect(payments.has('payments/src/index.ts')).toBe(true);
    expect(payments.has('payments/src/payment-records.ts')).toBe(true);
    expect(payments.has('payments/src/methods.ts')).toBe(true);
  });
});
