// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * Every detail page tab shows its content in the shared `TabPanel` (owner
 * decision 2026-10-27): each direct child of a `TabsContent` is a `TabPanel`,
 * or a component whose file renders one (directly, or through one more
 * component that does). Spacing between the panels comes from `TabsContent`.
 */

// Every CSMS source file except tests; keys are paths relative to this file.
const SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const PANEL = 'TabPanel';

/** Children that render outside the page flow (portal dialogs), allowed next to the panels. */
const OUT_OF_FLOW = new Set(['ConfirmDialog', 'Dialog']);

/**
 * Files whose tabs are not detail page tabs: settings, logs, reports, the
 * notification pages, the profile and certificates keep their own layout.
 */
const NOT_DETAIL_TABS: Record<string, string> = {
  'pages/Settings.tsx': 'settings page tabs',
  'pages/Profile.tsx': 'profile page tabs',
  'pages/Reports.tsx': 'reports page tabs',
  'pages/NotificationRules.tsx': 'notification settings page tabs',
  'pages/NotificationHistory.tsx': 'notification log page tabs',
  'pages/AccessLogs.tsx': 'logs page tabs',
  'pages/Certificates.tsx': 'certificates page tabs',
  'components/settings/IntegrationsSettings.tsx': 'settings sub-tabs',
  'components/settings/PaymentSettings.tsx': 'settings sub-tabs',
  'components/settings/NotificationSettings.tsx': 'settings sub-tabs',
  'components/settings/ContentSettings.tsx': 'settings sub-tabs',
  'components/settings/OcppDataPlanSettings.tsx': 'settings sub-tabs',
  'components/settings/ApiKeysSettings.tsx': 'settings sub-tabs',
  'components/settings/AiSettings.tsx': 'settings sub-tabs',
  'components/reports/NeviComplianceTab.tsx': 'reports page sub-tabs',
  'components/certificates/StationCertificatesTab.tsx': 'certificates page tab',
  'components/certificates/CsrRequestsTab.tsx': 'certificates page tab',
  'components/certificates/CaCertificatesTab.tsx': 'certificates page tab',
  'components/ui/tabs.tsx': 'the tabs primitive itself',
};

function srcPath(key: string): string {
  return key.replace(/^\.\.\/\.\.\//, '');
}

const FILES = new Map<string, string>(
  Object.entries(SOURCES).map(([key, text]) => [srcPath(key), text]),
);

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile | undefined {
  const cached = parsed.get(file);
  if (cached != null) return cached;
  const text = FILES.get(file);
  if (text == null) return undefined;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  parsed.set(file, source);
  return source;
}

function joinPath(fromFile: string, spec: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** The source file a module specifier points at, or undefined outside the CSMS sources. */
function resolveModule(fromFile: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = joinPath(fromFile, spec);
  else return undefined;
  base = base.replace(/\.js$/, '');
  for (const candidate of [`${base}.tsx`, `${base}/index.tsx`]) {
    if (FILES.has(candidate)) return candidate;
  }
  return undefined;
}

/** Where a component used in `file` is defined: its file, and the node when it is local. */
function definitionOf(file: string, name: string): { file: string; node?: ts.Node } | undefined {
  const source = parse(file);
  if (source == null) return undefined;
  let found: { file: string; node?: ts.Node } | undefined;
  const walk = (node: ts.Node): void => {
    if (found != null) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings != null && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if (el.name.text === name) {
            const target = resolveModule(file, node.moduleSpecifier.text);
            if (target != null) found = { file: target };
          }
        }
      }
    } else if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = { file, node };
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      const lazy = /import\(\s*['"]([^'"]+)['"]\s*\)/.exec(node.initializer?.getText(source) ?? '');
      const target = lazy?.[1] != null ? resolveModule(file, lazy[1]) : undefined;
      found = target != null ? { file: target } : { file, node };
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function tagOf(node: JsxNode): string {
  return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText();
}

/** Every JSX tag name used inside `node`. */
function tagsIn(node: ts.Node): Set<string> {
  const tags = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) tags.add(tagOf(n));
    ts.forEachChild(n, walk);
  };
  walk(node);
  return tags;
}

/** Whether a component renders a `TabPanel`, directly or through `depth` more components. */
function rendersPanel(file: string, name: string, depth: number): boolean {
  if (name === PANEL) return true;
  const def = definitionOf(file, name);
  if (def == null) return false;
  const scope = def.node ?? parse(def.file);
  if (scope == null) return false;
  const tags = tagsIn(scope);
  if (tags.has(PANEL)) return true;
  if (depth === 0) return false;
  for (const tag of tags) {
    if (!/^[A-Z]/.test(tag) || tag === name) continue;
    if (rendersPanel(def.file, tag, depth - 1)) return true;
  }
  return false;
}

/** The elements a JSX child can render: through fragments, conditions and `.map` callbacks. */
function renderedElements(child: ts.Node, problems: string[]): JsxNode[] {
  const out: JsxNode[] = [];
  const visitExpr = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) visitExpr(e.expression);
    else if (ts.isBinaryExpression(e)) visitExpr(e.right);
    else if (ts.isConditionalExpression(e)) {
      visitExpr(e.whenTrue);
      visitExpr(e.whenFalse);
    } else if (e.kind === ts.SyntaxKind.NullKeyword) return;
    else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const callback = e.arguments[0];
      if (callback != null && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        if (ts.isBlock(callback.body)) {
          const walkReturns = (n: ts.Node): void => {
            if (ts.isReturnStatement(n) && n.expression != null) visitExpr(n.expression);
            else if (!ts.isFunctionLike(n)) ts.forEachChild(n, walkReturns);
          };
          walkReturns(callback.body);
        } else visitExpr(callback.body);
      } else problems.push(e.getText());
    } else if (ts.isJsxFragment(e)) visitChildren(e.children);
    else if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) out.push(e);
    else problems.push(e.getText());
  };
  const visitChildren = (children: ts.NodeArray<ts.JsxChild>): void => {
    for (const c of children) visitNode(c);
  };
  const visitNode = (c: ts.Node): void => {
    if (ts.isJsxText(c)) {
      if (c.text.trim() !== '') problems.push(c.text.trim());
    } else if (ts.isJsxExpression(c)) {
      if (c.expression != null) visitExpr(c.expression);
    } else if (ts.isJsxFragment(c)) visitChildren(c.children);
    else if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) out.push(c);
  };
  visitNode(child);
  return out;
}

/** `file:line <tag>` for every direct child of a TabsContent that is not a panel. */
function panelProblems(file: string): string[] {
  const source = parse(file);
  if (source == null) return [];
  const problems: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && tagOf(node) === 'TabsContent') {
      for (const child of node.children) {
        const raw: string[] = [];
        for (const el of renderedElements(child, raw)) {
          const tag = tagOf(el);
          if (!OUT_OF_FLOW.has(tag) && !rendersPanel(file, tag, 2)) {
            const line = source.getLineAndCharacterOfPosition(el.getStart()).line + 1;
            problems.push(`${file}:${String(line)} <${tag}>`);
          }
        }
        for (const text of raw) {
          const line = source.getLineAndCharacterOfPosition(child.getStart()).line + 1;
          problems.push(`${file}:${String(line)} ${text.slice(0, 40)}`);
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return problems;
}

describe('detail page tabs', () => {
  it('scan the CSMS sources', () => {
    expect(FILES.size).toBeGreaterThan(100);
    expect(FILES.has('components/ui/tab-panel.tsx')).toBe(true);
  });

  it('show every tab in the shared TabPanel', () => {
    const problems: string[] = [];
    for (const file of FILES.keys()) {
      if (NOT_DETAIL_TABS[file] != null) continue;
      problems.push(...panelProblems(file));
    }
    expect(problems).toEqual([]);
  });

  it('list only files that exist and still have tabs', () => {
    for (const file of Object.keys(NOT_DETAIL_TABS)) {
      expect(FILES.get(file) ?? '', file).toContain('TabsContent');
    }
  });

  it('set no spacing on a detail page TabsContent', () => {
    const offenders: string[] = [];
    for (const [file, text] of FILES) {
      if (NOT_DETAIL_TABS[file] != null) continue;
      for (const match of text.matchAll(/<TabsContent\b[^>]*className=/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
