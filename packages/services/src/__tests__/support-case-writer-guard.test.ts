// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * TC-AI-DR-21: `support-case.service.ts` is the single writer of support
 * cases (design principle P3, plan v0.1.45 section 2.13). No other source file
 * inserts, updates or deletes `support_cases`, `support_case_messages`,
 * `support_case_sessions`, `support_case_reads`, `support_case_attachments`
 * or `support_case_audit_log` rows, through Drizzle, `writeAudit` or raw SQL.
 * The seed scripts write demo data directly and are the only exception.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = resolve(import.meta.dirname, '../../..');

const SERVICE = 'services/src/support-case.service.ts';
const ALLOWED = new Set([SERVICE, 'database/src/seed.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('__')) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const files = readdirSync(PACKAGES)
  .map((pkg) => join(PACKAGES, pkg, 'src'))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      // fail-open: a package without a src folder holds no writer
      return false;
    }
  })
  .flatMap(sourceFiles)
  .map((path) => ({ path: relative(PACKAGES, path), text: readFileSync(path, 'utf8') }));

const TABLES =
  'supportCases|supportCaseMessages|supportCaseSessions|supportCaseReads|supportCaseAttachments|supportCaseAuditLog';
const DRIZZLE_WRITE = new RegExp(`\\.(?:insert|update|delete)\\(\\s*(?:${TABLES})\\b`);
const AUDIT_WRITE = /table:\s*supportCaseAuditLog\b/;
const SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?support_case(?:s|_messages|_sessions|_reads|_attachments|_audit_log)\b/i;

describe('support case single writer (TC-AI-DR-21)', () => {
  it('TC-AI-DR-21 scans the source of every package', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.path === SERVICE)).toBe(true);
  });

  it('TC-AI-DR-21 the service writes every support case table', () => {
    const service = files.find((f) => f.path === SERVICE)?.text ?? '';
    for (const table of TABLES.split('|').filter((t) => t !== 'supportCaseAuditLog')) {
      expect(new RegExp(`\\.(?:insert|update|delete)\\(\\s*${table}\\b`).test(service), table).toBe(
        true,
      );
    }
    expect(AUDIT_WRITE.test(service)).toBe(true);
  });

  it('TC-AI-DR-21 no other file writes a support case table', () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f.path))
      .filter(
        (f) => DRIZZLE_WRITE.test(f.text) || AUDIT_WRITE.test(f.text) || SQL_WRITE.test(f.text),
      )
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
