// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * Every portal option switch (two or more buttons that pick one view, such as
 * Energy or Power, Upcoming or Past) is the shared `SegmentedControl`
 * (`components/ui/segmented-control.tsx`, `frontend/ui.md`). This scans every
 * portal source file outside `components/ui` and fails on a hand-built switch:
 * a JSX element whose direct children are two or more toggling buttons (a
 * `button` or `Button` with `aria-pressed` or `aria-checked`, or whose class
 * or variant depends on a comparison such as `tab === 'past'`), one of them
 * rendered from a `.map()`, or a `role="group"` or `role="radiogroup"` element
 * holding such a button.
 */

const SOURCES = import.meta.glob<string>(
  ['../../**/*.tsx', '!**/__tests__/**', '!../../components/ui/**'],
  { query: '?raw', import: 'default', eager: true },
);

/**
 * Hand-built switches allowed per file, each with the reason. A new switch in
 * one of these files raises its count and fails.
 */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  '../../components/account/AvatarEditor.tsx': {
    count: 1,
    reason:
      'the avatar color swatches: a radio group of color circles with no text label, a color picker rather than a view switch',
  },
};

const BUTTON_TAGS = new Set(['button', 'Button']);
const TOGGLE_ATTRS = new Set(['aria-pressed', 'aria-checked']);
const STYLE_ATTRS = new Set(['className', 'variant']);

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText();
}

function attributes(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function hasComparison(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** A `button` or `Button` that shows whether it is the picked option. */
function isToggleButton(node: ts.Node): boolean {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  if (!BUTTON_TAGS.has(tagName(node))) return false;
  for (const attr of attributes(node).properties) {
    if (!ts.isJsxAttribute(attr)) continue;
    const name = attr.name.getText();
    if (TOGGLE_ATTRS.has(name)) return true;
    if (STYLE_ATTRS.has(name) && attr.initializer != null && hasComparison(attr.initializer)) {
      return true;
    }
  }
  return false;
}

/** Whether a `.map()` callback returns a toggle button itself (not one nested deeper). */
function mappedToggle(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'map') return false;
  const fn = expr.arguments[0];
  if (fn == null || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
  const returned: ts.Expression[] = [];
  if (ts.isBlock(fn.body)) {
    for (const statement of fn.body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression != null) {
        returned.push(statement.expression);
      }
    }
  } else {
    returned.push(fn.body);
  }
  return returned.some((e) => {
    let inner = e;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    return isToggleButton(inner);
  });
}

/** Counts the toggle buttons among an element's direct children; a mapped one counts as two. */
function toggleChildren(node: ts.JsxElement): number {
  let count = 0;
  for (const child of node.children) {
    if (isToggleButton(child)) count += 1;
    else if (ts.isJsxExpression(child) && child.expression != null) {
      let expr = child.expression;
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (mappedToggle(expr)) count += 2;
    }
  }
  return count;
}

function groupRole(node: ts.JsxElement): boolean {
  for (const attr of node.openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'role') continue;
    const init = attr.initializer;
    if (init != null && ts.isStringLiteral(init)) {
      return init.text === 'group' || init.text === 'radiogroup';
    }
  }
  return false;
}

/** The hand-built switches in one source file, as `line: tag` strings. */
function findOptionSwitches(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const toggles = toggleChildren(node);
      if (toggles >= 2 || (toggles >= 1 && groupRole(node))) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push(`${String(line)}: <${tagName(node)}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('portal option switches', () => {
  it('scans the portal source', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  // Parses every portal source file: under coverage on a CI runner it can take
  // longer than the 5 s default.
  it('builds every option switch with the shared SegmentedControl', { timeout: 30_000 }, () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      const switches = findOptionSwitches(file, source);
      const allowed = ALLOWED[file]?.count ?? 0;
      if (switches.length > allowed) {
        offenders.push(`${file}: ${switches.join(', ')} (allowed ${String(allowed)})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lists only files that still hold their allowed switches', () => {
    for (const [file, { count }] of Object.entries(ALLOWED)) {
      const source = SOURCES[file];
      expect(source, file).toBeDefined();
      expect(findOptionSwitches(file, source ?? ''), file).toHaveLength(count);
    }
  });

  it('catches the hand-built shapes', () => {
    const pressed = `const a = (
      <div role="group">
        {(['x', 'y'] as const).map((m) => (
          <Button key={m} aria-pressed={tab === m} onClick={() => setTab(m)}>{m}</Button>
        ))}
      </div>
    );`;
    const styled = `const a = (
      <div className="flex">
        <button className={tab === 'a' ? 'bg-card' : ''} onClick={() => setTab('a')}>A</button>
        <button className={tab === 'b' ? 'bg-card' : ''} onClick={() => setTab('b')}>B</button>
      </div>
    );`;
    const plain = `const a = (
      <div className="flex gap-2">
        <Button onClick={save}>Save</Button>
        <Button variant="outline" onClick={cancel}>Cancel</Button>
      </div>
    );`;
    expect(findOptionSwitches('a.tsx', pressed)).toHaveLength(1);
    expect(findOptionSwitches('b.tsx', styled)).toHaveLength(1);
    expect(findOptionSwitches('c.tsx', plain)).toEqual([]);
    expect(
      findOptionSwitches(
        'd.tsx',
        `const a = <SegmentedControl aria-label="x" value={v} onValueChange={set} options={o} />;`,
      ),
    ).toEqual([]);
  });
});
