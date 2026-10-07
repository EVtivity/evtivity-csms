// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';

// Accessible names are translated (frontend/i18n.md): a screen reader must not
// announce English on a German, Spanish, Korean or Chinese page. This test fails
// on an aria-label, alt or sr-only text written as a string literal.

// Every non-test .tsx source file, keyed by path relative to this directory.
const SOURCES = import.meta.glob<string>(
  ['../../**/*.tsx', '!../../**/*.test.tsx', '!../../**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
);
// Product names stay in English in every language.
const ALLOWED_LITERALS = new Set(['EVtivity']);

// Returns the JSX expression starting at the `{` at `start`, braces balanced.
function expressionAt(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return src.slice(start + 1);
}

// Removes every t(...) call, so its key and fallback do not count as literals.
function stripTranslateCalls(expr: string): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const match = /\bt\(/.exec(expr.slice(i));
    if (match == null) return out + expr.slice(i);
    out += expr.slice(i, i + match.index);
    let depth = 0;
    let j = i + match.index + 1;
    for (; j < expr.length; j++) {
      if (expr[j] === '(') depth++;
      else if (expr[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

function literalsIn(expr: string): string[] {
  const found: string[] = [];
  for (const m of stripTranslateCalls(expr).matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    const text = (m[2] ?? '').replace(/\$\{[^}]*\}/g, '').trim();
    if (/[A-Za-z]/.test(text) && !ALLOWED_LITERALS.has(text)) found.push(m[0]);
  }
  return found;
}

function findLiteralAccessibleNames(src: string): string[] {
  const issues: string[] = [];
  for (const m of src.matchAll(/\b(aria-label|alt)=("([^"]*)"|\{)/g)) {
    const attr = m[1] ?? '';
    if (m[3] != null) {
      const text = m[3].trim();
      if (/[A-Za-z]/.test(text) && !ALLOWED_LITERALS.has(text)) issues.push(`${attr}="${m[3]}"`);
    } else {
      for (const lit of literalsIn(expressionAt(src, m.index + attr.length + 1))) {
        issues.push(`${attr}={${lit}}`);
      }
    }
  }
  for (const m of src.matchAll(/className=["'{][^>]*\bsr-only\b[^>]*>([^<{]*)/g)) {
    const text = (m[1] ?? '').trim();
    if (/[A-Za-z]/.test(text) && !ALLOWED_LITERALS.has(text)) issues.push(`sr-only "${text}"`);
  }
  return issues;
}

describe('accessible names', () => {
  it('detects literal accessible names', () => {
    expect(findLiteralAccessibleNames('<b aria-label="Close" />')).toHaveLength(1);
    expect(findLiteralAccessibleNames("<b aria-label={'Close'} />")).toHaveLength(1);
    expect(findLiteralAccessibleNames('<b aria-label={`Remove ${tag}`} />')).toHaveLength(1);
    expect(findLiteralAccessibleNames("<b aria-label={open ? 'Hide' : t('x')} />")).toHaveLength(1);
    expect(findLiteralAccessibleNames('<img alt="QR Code" />')).toHaveLength(1);
    expect(findLiteralAccessibleNames('<span className="sr-only">Close</span>')).toHaveLength(1);
    expect(findLiteralAccessibleNames("<b aria-label={t('common.close')} />")).toEqual([]);
    expect(findLiteralAccessibleNames("<b aria-label={t('a.b', 'Fallback')} />")).toEqual([]);
    expect(findLiteralAccessibleNames("<b aria-label={t('a', { n: `${x}` })} />")).toEqual([]);
    expect(findLiteralAccessibleNames('<img alt="" /><img alt="EVtivity" />')).toEqual([]);
    expect(
      findLiteralAccessibleNames('<span className="sr-only">{t(\'common.close\')}</span>'),
    ).toEqual([]);
  });

  it('has no string-literal aria-label, alt or sr-only text in the portal source', () => {
    const files = Object.entries(SOURCES);
    expect(files.length).toBeGreaterThan(80);
    const issues = files.flatMap(([file, src]) =>
      findLiteralAccessibleNames(src).map((issue) => `${file.slice(6)}: ${issue}`),
    );
    expect(issues).toEqual([]);
  });
});
