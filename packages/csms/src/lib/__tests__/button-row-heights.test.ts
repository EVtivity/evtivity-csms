// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * Buttons side by side in one action row share a height (ISSUES item 10:
 * Edit, Assign Station and Cancel Reservation differed). The shared text
 * buttons (`EditButton`, `RemoveButton`, ...) use the default size, so a
 * `size="sm"` button next to them is shorter. This scans every CSMS source
 * file for JSX elements whose direct button children differ in height.
 */

// Every CSMS source file except tests.
const SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Tailwind height units of each `Button` size (`components/ui/button.tsx`); header is h-10 from sm. */
const SIZE_HEIGHT: Record<string, number> = {
  default: 10,
  sm: 9,
  lg: 11,
  icon: 10,
  header: 10,
  xs: 7,
  'icon-sm': 8,
  'icon-xs': 6,
  chip: 6,
  fab: 12,
};

/** Shared text buttons: the default size unless a `size` prop says otherwise. */
const SHARED_TEXT_BUTTON =
  /^(Edit|Remove|Cancel|Save|Abort|Add|Create|Export|Import|Generate|Push|Reset|Start|Template|Refund|Recalculate|Enable|Disable|Confirm|Reject)Button$/;
/** Shared icon buttons: `md` (h-10) by default, `sm` is h-9. */
const SHARED_ICON_BUTTON = /IconButton$/;
/** Wrappers that hold one button (a link, a tooltip span). */
const WRAPPERS = new Set(['Link', 'span', 'Tooltip']);

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function openingOf(node: JsxNode): ts.JsxOpeningLikeElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function attribute(el: ts.JsxOpeningLikeElement, name: string): string | true | undefined {
  for (const prop of el.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== name) continue;
    if (prop.initializer == null) return true;
    if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
    return prop.initializer.getText();
  }
  return undefined;
}

function jsxChildren(node: ts.JsxElement): JsxNode[] {
  const out: JsxNode[] = [];
  const visit = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) visit(e.expression);
    else if (ts.isBinaryExpression(e)) visit(e.right);
    else if (ts.isConditionalExpression(e)) {
      visit(e.whenTrue);
      visit(e.whenFalse);
    } else if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) out.push(e);
  };
  for (const child of node.children) {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) out.push(child);
    else if (ts.isJsxExpression(child) && child.expression != null) visit(child.expression);
  }
  return out;
}

/** The desktop height of a button element, or undefined when it is not a button. */
function buttonHeight(node: JsxNode): number | string | undefined {
  const open = openingOf(node);
  const tag = open.tagName.getText();
  const className = attribute(open, 'className');
  const classes = typeof className === 'string' ? className : '';
  const smHeight = /(?:^|\s)sm:h-(\d+)(?:\s|$)/.exec(classes);
  const height = /(?:^|\s)h-(\d+)(?:\s|$)/.exec(classes);
  const size = attribute(open, 'size');
  if (tag === 'Button') {
    if (smHeight != null) return Number(smHeight[1]);
    if (height != null) return Number(height[1]);
    if (size === undefined) return SIZE_HEIGHT.default;
    if (typeof size === 'string' && size in SIZE_HEIGHT) return SIZE_HEIGHT[size];
    return `dynamic size ${String(size)}`;
  }
  if (tag === 'ExplainButton') return attribute(open, 'iconOnly') != null ? 8 : 10;
  if (SHARED_TEXT_BUTTON.test(tag) || SHARED_ICON_BUTTON.test(tag)) {
    return size === 'sm' ? 9 : 10;
  }
  if (WRAPPERS.has(tag) && ts.isJsxElement(node)) {
    const inner = jsxChildren(node);
    if (inner.length === 1 && inner[0] != null) return buttonHeight(inner[0]);
  }
  return undefined;
}

function mixedRows(): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(SOURCES)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = (node: ts.Node): void => {
      if (ts.isJsxElement(node)) {
        const buttons = jsxChildren(node)
          .map((child) => ({ child, height: buttonHeight(child) }))
          .filter((b) => b.height !== undefined);
        if (buttons.length >= 2 && new Set(buttons.map((b) => b.height)).size > 1) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const list = buttons
            .map((b) => `${openingOf(b.child).tagName.getText()}=${String(b.height)}`)
            .join(' ');
          found.push(`${file}:${String(line)} ${list}`);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return found;
}

describe('button rows', () => {
  it('scans the CSMS sources', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it('give the buttons of one row the same height', () => {
    expect(mixedRows()).toEqual([]);
  });
});
