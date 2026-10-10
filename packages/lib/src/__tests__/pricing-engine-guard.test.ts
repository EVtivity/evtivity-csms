// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Guard: money math only in the pricing engine (owner decision 2026-10-09).
// Every amount the system charges or shows comes from
// packages/lib/src/pricing-engine.ts and the two modules it is built on. This
// test scans the source of every package and fails when it finds tax-rate
// multiplication or division, price times quantity, or rounding to cents
// anywhere else. Display formatting, the test oracle, and the station
// simulator are allowed by name. Call sites not yet moved onto the engine are
// listed with the lane that moves them; the test also fails when a listed
// file no longer matches, so the list only shrinks.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/**
 * Not scanned: the engine, the only files where money math belongs, and the
 * test-only oracle, which restates the rules independently of the engine.
 */
const EXEMPT = new Set([
  'packages/lib/src/pricing-engine.ts',
  'packages/lib/src/cost-calculator.ts',
  'packages/lib/src/price-display.ts',
  'packages/lib/src/testing/pricing-oracle.ts',
]);

/** Files allowed to match, with the reason. */
const ALLOWED: Record<string, string> = {
  'packages/lib/src/currency.ts': 'display formatting of cents and unit prices',
  'packages/css/src/station-simulator.ts':
    'the station simulator computes the station-side local cost (OCPP 2.1 I02), not CSMS billing',
};

/**
 * Call sites that still compute money on their own, with the lane that moves
 * them onto the engine. Remove an entry when its file no longer matches.
 */
const NOT_YET_ON_ENGINE: Record<string, string> = {};

const MONEY_WORDS = /cent|cost|amount|price|fee|balance|charge|refund|tax|settle|paid|credit/i;

/** A money word on the line, not counting "percent". */
function mentionsMoney(line: string): boolean {
  return MONEY_WORDS.test(line.replace(/percent/gi, ''));
}

/** A unit price name: price..., ratePer..., feePer..., costPer... */
const PRICE_NAME = String.raw`[\w.?]*(?:price|rate_?per|fee_?per|cost_?per)\w*`;

const PATTERNS: { name: string; test: (line: string) => boolean }[] = [
  {
    name: 'tax rate multiplied or divided',
    test: (line) =>
      /(?:tax_?rate|vat_?rate)\b\s*\)?\s*[*/]/i.test(line) ||
      /[*/]\s*\(?\s*(?:1\s*\+\s*)?[\w.?]*(?:tax_?rate|vat_?rate)\b/i.test(line),
  },
  {
    name: 'price times quantity',
    test: (line) =>
      new RegExp(String.raw`[\w.)\]]\s*\*\s*\(?${PRICE_NAME}\b`, 'i').test(line) ||
      new RegExp(String.raw`\b${PRICE_NAME}\s*\)?\s*\*\s*[\w(]`, 'i').test(line),
  },
  {
    name: 'rounding to cents',
    test: (line) =>
      mentionsMoney(line) &&
      /Math\.(?:round|floor|ceil|trunc)\([^;]*\*\s*100\b(?!\s*\)\s*\/\s*100)/.test(line),
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    const rel = relative(ROOT, path);
    if (statSync(path).isDirectory()) {
      if (/(^|\/)(__tests__|__integration__|generated|e2e)$/.test(rel)) continue;
      if (rel === 'packages/octt/src/tests') continue;
      sourceFiles(path, out);
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.(test|spec)\.tsx?$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(rel);
    }
  }
  return out;
}

/** Line comments and block comment lines are not code. */
function codeOf(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line.replace(/\/\/.*$/, '');
}

function findings(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const packages = join(ROOT, 'packages');
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, 'src');
    let isDir = false;
    try {
      isDir = statSync(src).isDirectory();
    } catch {
      // fail-open: a package without a src folder has no source to scan
      isDir = false;
    }
    if (!isDir) continue;
    for (const file of sourceFiles(src)) {
      if (EXEMPT.has(file)) continue;
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      lines.forEach((raw, index) => {
        const line = codeOf(raw);
        for (const pattern of PATTERNS) {
          if (pattern.test(line)) {
            const list = found.get(file) ?? [];
            list.push(`${String(index + 1)}: ${pattern.name}: ${raw.trim()}`);
            found.set(file, list);
          }
        }
      });
    }
  }
  return found;
}

describe('pricing engine guard', () => {
  const found = findings();

  it('finds no money math outside the pricing engine', () => {
    const offending = [...found.entries()]
      .filter(([file]) => ALLOWED[file] == null && NOT_YET_ON_ENGINE[file] == null)
      .flatMap(([file, lines]) => lines.map((l) => `${file}:${l}`));
    expect(offending).toEqual([]);
  });

  it('lists only files that still match (remove an entry once the file uses the engine)', () => {
    const stale = Object.keys({ ...ALLOWED, ...NOT_YET_ON_ENGINE }).filter((f) => !found.has(f));
    expect(stale).toEqual([]);
  });

  it('detects each kind of money math', () => {
    const [tax, price, cents] = PATTERNS;
    expect(tax?.test('const tax = Math.round(net * taxRate);')).toBe(true);
    expect(tax?.test('ROUND(net_cents * t.tax_rate)')).toBe(true);
    expect(tax?.test('const net = gross / (1 + session.tariffTaxRate);')).toBe(true);
    expect(price?.test('const cost = kwh * tariff.pricePerKwh;')).toBe(true);
    expect(price?.test('const fee = minutes * ratePerMinute * 100;')).toBe(true);
    expect(cents?.test('const amountCents = Math.round(amount * 100);')).toBe(true);
    expect(cents?.test('uptimePercent: Math.round(uptime * 100) / 100,')).toBe(false);
    expect(cents?.test('const kw = Math.round(allocatedKw * 100);')).toBe(false);
    expect(cents?.test('onlinePercent: Math.round((online / total) * 100),')).toBe(false);
    expect(price?.test('const co2 = energyKwh * carbonIntensityKgPerKwh;')).toBe(false);
  });
});
