// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Guard: OCPP 2.0.1 stations run the 2.x model. A check `protocol === 'ocpp2.1'`
// sends a 2.0.1 station down neither the 2.x nor the 1.6 path, so source code
// asks `isOcpp2x(protocol)` (the 2.x message model) or `isOcpp21(protocol)` (a
// feature only OCPP 2.1 has) from @evtivity/lib/ocpp-version. This test scans
// the source of every package and fails on a comparison of anything to the
// literal 'ocpp2.1' outside the helper. Files whose checks another change
// clears are listed below; the test also fails when a listed file no longer
// matches, so the list only shrinks.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/** The helper itself, where the literal comparison belongs. */
const EXEMPT = new Set(['packages/lib/src/ocpp-version.ts']);

/**
 * Pending: files the simulator's OCPP 2.0.1 work still moves onto the
 * helpers. Remove each entry when its file uses them.
 */
const PENDING: Record<string, string> = {};

/**
 * SQL that picks a feature only OCPP 2.1 has, where a query cannot call
 * isOcpp21. Each entry names the feature; the stale check applies too.
 */
const OCPP21_FEATURE_SQL: Record<string, string> = {
  'packages/worker/src/handlers/certificate-expiration-check.ts':
    'V2G20Certificate renewal (ISO 15118-20, OCPP 2.1 only)',
};

const LITERAL = 'ocpp2.1';

const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Drizzle comparisons that take the value as an argument: `eq(col, 'ocpp2.1')`. */
const DRIZZLE_COMPARISON = new Set(['eq', 'ne']);

/** Drizzle list comparisons: `inArray(col, ['ocpp2.1'])`. */
const DRIZZLE_LIST_COMPARISON = new Set(['inArray', 'notInArray']);

/** Membership tests on a list: `['ocpp2.1'].includes(p)`, `new Set(['ocpp2.1']).has(p)`. */
const MEMBERSHIP = new Set(['includes', 'indexOf', 'has']);

/** `= 'ocpp2.1'`, `<> 'ocpp2.1'`, `'ocpp2.1' !=` in SQL text. */
const SQL_COMPARISON = /(?:=|<>|!=)\s*'ocpp2\.1'|'ocpp2\.1'\s*(?:=|<>|!=)/;

/** An SQL `IN (...)` list that names 'ocpp2.1' and not 'ocpp2.0.1'. */
const SQL_IN_LIST = /\bIN\s*\(([^)]*'ocpp2\.1'[^)]*)\)/i;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    const rel = relative(ROOT, path);
    if (statSync(path).isDirectory()) {
      if (/(^|\/)(__tests__|__integration__|generated|e2e)$/.test(rel)) continue;
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

function isOcpp21Literal(node: ts.Node): boolean {
  return (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === LITERAL
  );
}

/**
 * A list that holds 'ocpp2.1' but not 'ocpp2.0.1': a membership test on it
 * leaves 2.0.1 stations out. A list naming both versions is a value list.
 */
function ocpp21OnlyList(node: ts.Node | undefined): ts.Expression | null {
  if (node == null) return null;
  let inner: ts.Node = node;
  while (
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isParenthesizedExpression(inner)
  ) {
    inner = inner.expression;
  }
  if (!ts.isArrayLiteralExpression(inner)) return null;
  const texts = inner.elements
    .filter((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
    .map((e) => (e as ts.StringLiteral).text);
  if (!texts.includes(LITERAL) || texts.includes('ocpp2.0.1')) return null;
  return inner.elements.find(isOcpp21Literal) ?? null;
}

/** The list a `new Set([...])` is built from, else the node itself. */
function setSource(node: ts.Node | undefined): ts.Node | undefined {
  if (node != null && ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text === 'Set' ? node.arguments?.[0] : undefined;
  }
  return node;
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
}

function isTemplateText(node: ts.Node): node is ts.TemplateLiteralLikeNode {
  return (
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/**
 * The lines of the 'ocpp2.1' literals that are compared, read from the syntax
 * tree (comments, strings and regular expressions are never mistaken for code):
 * equality operators, `case 'ocpp2.1':`, Drizzle `eq`/`ne` and SQL text.
 */
function comparisonLines(source: string, fileName = 'source.tsx'): number[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = new Set<number>();
  const mark = (node: ts.Node): void => {
    lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  };
  // Lists bound to a name (`const V2 = ['ocpp2.1']`, `new Set([...])`), so a
  // later `V2.includes(p)` or `V2.has(p)` is found too.
  const namedLists = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const literal = ocpp21OnlyList(setSource(node.initializer));
      if (literal != null) namedLists.set(node.name.text, literal);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      if (isOcpp21Literal(node.left)) mark(node.left);
      if (isOcpp21Literal(node.right)) mark(node.right);
    } else if (ts.isCaseClause(node) && isOcpp21Literal(node.expression)) {
      mark(node.expression);
    } else if (ts.isCallExpression(node) && DRIZZLE_COMPARISON.has(calleeName(node))) {
      node.arguments.filter(isOcpp21Literal).forEach(mark);
    } else if (ts.isCallExpression(node) && DRIZZLE_LIST_COMPARISON.has(calleeName(node))) {
      const literal = ocpp21OnlyList(node.arguments[1]);
      if (literal != null) mark(literal);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MEMBERSHIP.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      const literal = ts.isIdentifier(receiver)
        ? (namedLists.get(receiver.text) ?? null)
        : ocpp21OnlyList(setSource(receiver));
      if (literal != null) mark(literal);
    } else if (isTemplateText(node) || ts.isStringLiteral(node)) {
      // The line of the comparison inside a multi-line SQL text.
      const raw = node.getText(file);
      let at = raw.search(SQL_COMPARISON);
      const inList = SQL_IN_LIST.exec(raw);
      if (at < 0 && inList != null && !inList[1]!.includes("'ocpp2.0.1'")) {
        at = inList.index + inList[0].indexOf("'ocpp2.1'");
      }
      if (at >= 0) {
        const start = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        lines.add(start + (raw.slice(0, at).match(/\n/g)?.length ?? 0));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...lines].sort((a, b) => a - b);
}

function findings(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  const packages = join(ROOT, 'packages');
  for (const pkg of readdirSync(packages)) {
    // The OCTT conformance runner drives each protocol on purpose.
    if (pkg === 'octt') continue;
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
      const lines = comparisonLines(readFileSync(join(ROOT, file), 'utf8'), file);
      if (lines.length > 0) found.set(file, lines);
    }
  }
  return found;
}

describe('OCPP version guard', () => {
  const found = findings();

  it("finds no comparison to 'ocpp2.1' outside the helper (use isOcpp2x or isOcpp21)", () => {
    const offending = [...found.entries()]
      .filter(([file]) => PENDING[file] == null && OCPP21_FEATURE_SQL[file] == null)
      .flatMap(([file, lines]) => lines.map((line) => `${file}:${String(line)}`));
    expect(offending).toEqual([]);
  });

  it('lists only files that still match (remove an entry once the file uses the helpers)', () => {
    const stale = [...Object.keys(PENDING), ...Object.keys(OCPP21_FEATURE_SQL)].filter(
      (file) => !found.has(file),
    );
    expect(stale).toEqual([]);
  });

  it('detects each comparison form', () => {
    expect(comparisonLines("if (protocol === 'ocpp2.1') {}")).toEqual([1]);
    expect(comparisonLines('if (p !== "ocpp2.1") {}')).toEqual([1]);
    expect(comparisonLines("if ('ocpp2.1' == p) {}")).toEqual([1]);
    expect(comparisonLines("switch (p) {\n  case 'ocpp2.1':\n}")).toEqual([2]);
    expect(comparisonLines("const ok =\n  station.ocppProtocol ===\n    'ocpp2.1';")).toEqual([3]);
  });

  it('ignores values, other versions and comments', () => {
    expect(comparisonLines("const v = 'ocpp2.1';")).toEqual([]);
    expect(comparisonLines("register('ocpp2.1', 'Heartbeat', h);")).toEqual([]);
    expect(comparisonLines("if (p === 'ocpp1.6') {}")).toEqual([]);
    expect(comparisonLines("if (p === 'ocpp2.0.1') {}")).toEqual([]);
    expect(comparisonLines("// if (p === 'ocpp2.1')\n/* p === 'ocpp2.1' */")).toEqual([]);
  });

  it('detects Drizzle and SQL comparisons', () => {
    expect(comparisonLines("db.where(eq(chargingStations.ocppProtocol, 'ocpp2.1'));")).toEqual([1]);
    expect(comparisonLines("where(ne(t.protocol, 'ocpp2.1'))")).toEqual([1]);
    expect(comparisonLines("sql`WHERE st.ocpp_protocol = 'ocpp2.1'`;")).toEqual([1]);
    expect(comparisonLines("sql`SELECT 1\n  WHERE p <> 'ocpp2.1' AND ${x}`;")).toEqual([2]);
    expect(comparisonLines("sql`SELECT 1 WHERE ${x} AND p = 'ocpp2.1'`;")).toEqual([1]);
  });

  it('detects lists that name 2.1 and not 2.0.1', () => {
    expect(comparisonLines("inArray(t.p, ['ocpp2.1'])")).toEqual([1]);
    expect(comparisonLines("notInArray(t.p, ['ocpp1.6', 'ocpp2.1'])")).toEqual([1]);
    expect(comparisonLines("if (['ocpp2.1'].includes(p)) {}")).toEqual([1]);
    expect(comparisonLines("if (new Set(['ocpp2.1']).has(p)) {}")).toEqual([1]);
    expect(comparisonLines("const V2 = ['ocpp2.1'] as const;\nif (V2.includes(p)) {}")).toEqual([
      1,
    ]);
    expect(comparisonLines("const V2 = new Set(['ocpp2.1']);\nconst ok = V2.has(p);")).toEqual([1]);
    expect(comparisonLines("sql`WHERE p IN ('ocpp1.6', 'ocpp2.1')`;")).toEqual([1]);
  });

  it('ignores lists that name both 2.x versions and lists that are only values', () => {
    expect(comparisonLines("inArray(t.p, ['ocpp2.0.1', 'ocpp2.1'])")).toEqual([]);
    expect(comparisonLines("['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'].includes(p)")).toEqual([]);
    expect(comparisonLines("sql`WHERE p IN ('ocpp2.0.1', 'ocpp2.1')`;")).toEqual([]);
    expect(comparisonLines("for (const v of ['ocpp1.6', 'ocpp2.1']) {}")).toEqual([]);
    expect(comparisonLines("const V = ['ocpp2.1'];\nsend(V);")).toEqual([]);
  });

  it('is not misled by comment markers inside strings and regular expressions', () => {
    const source = [
      "const paths = ['/v1/dashboard/*', '/v1/ai/*'];",
      'const re = /^\\/v1\\/ocpp\\/commands\\/v(16|21)\\//;',
      "if (p === 'ocpp2.1') {}",
    ].join('\n');
    expect(comparisonLines(source)).toEqual([3]);
  });
});
