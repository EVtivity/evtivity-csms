// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * Controls side by side in one row share a height (ISSUES item 10: Edit,
 * Assign Station and Cancel Reservation differed; filter bars mixed a 40 px
 * search with 36 px selects). Buttons, inputs and selects have one height per
 * app (`frontend/ui.md`, control heights). This scans every CSMS and
 * portal source file for JSX elements whose direct control children (buttons,
 * inputs, selects, search fields, filter and column toggles) differ in height.
 */

// Every CSMS and portal source file except tests.
const CSMS_SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const PORTAL_SOURCES = import.meta.glob<string>(
  ['../../../../portal/src/**/*.tsx', '!**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
);

interface Scale {
  /** Tailwind height units of each `Button` size; header sizes count at their sm height. */
  button: Record<string, number>;
  /** Inputs, selects and the other fields (one height, no size prop). */
  control: number;
  /**
   * A documented pair of different heights that still form one row: the portal
   * puts a 40 px button next to a 48 px field (touch targets for typing, the
   * standard button height for actions).
   */
  fieldButtonPair?: { control: number; button: number };
}

const CSMS_SCALE: Scale = {
  button: {
    default: 10,
    sm: 10,
    lg: 11,
    icon: 10,
    header: 10,
    'icon-header': 10,
    xs: 7,
    'icon-sm': 8,
    'icon-xs': 6,
    chip: 6,
    fab: 12,
  },
  control: 10,
};

const PORTAL_SCALE: Scale = {
  button: { default: 10, sm: 9, lg: 11, icon: 10 },
  control: 12,
  fieldButtonPair: { control: 12, button: 10 },
};

/** Shared text buttons: the default size unless a `size` prop says otherwise. */
const SHARED_TEXT_BUTTON =
  /^(Edit|Remove|Cancel|Save|Abort|Add|Create|Export|Import|Generate|Push|Reset|Start|Template|Refund|Recalculate|Enable|Disable|Confirm|Reject)Button$/;
/** Shared icon buttons: always the Button `icon` size (h-10). */
const SHARED_ICON_BUTTON = /IconButton$/;
/** Inputs, selects, search fields and the filter and column toggles: one height, no size. */
const CONTROLS = new Set([
  'Input',
  'ClearableInput',
  'PasswordInput',
  'DecimalInput',
  'Select',
  'SearchInput',
  'Combobox',
  'MonthPicker',
  'LanguageSelect',
  'FilterPopover',
  'ColumnVisibilityToggle',
]);
/** Wrappers that hold one control (a link, a tooltip span, a flex cell). */
const WRAPPERS = new Set(['Link', 'span', 'Tooltip', 'div']);

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

/** `const searchInput = (<SearchInput ... />)`: JSX held in a local variable, by name. */
function jsxVariables(source: ts.SourceFile): Map<string, JsxNode> {
  const out = new Map<string, JsxNode>();
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init: ts.Expression = node.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isJsxElement(init) || ts.isJsxSelfClosingElement(init)) out.set(node.name.text, init);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

function jsxChildren(node: ts.JsxElement, vars: Map<string, JsxNode>): JsxNode[] {
  const out: JsxNode[] = [];
  const visit = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) visit(e.expression);
    else if (ts.isBinaryExpression(e)) visit(e.right);
    else if (ts.isConditionalExpression(e)) {
      visit(e.whenTrue);
      visit(e.whenFalse);
    } else if (ts.isIdentifier(e)) {
      const held = vars.get(e.text);
      if (held != null) out.push(held);
    } else if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e)) out.push(e);
  };
  for (const child of node.children) {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) out.push(child);
    else if (ts.isJsxExpression(child) && child.expression != null) visit(child.expression);
  }
  return out;
}

/** The desktop height of a control element, or undefined when it is not a control. */
function controlHeight(
  node: JsxNode,
  scale: Scale,
  vars: Map<string, JsxNode>,
): number | string | undefined {
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
    if (size === undefined) return scale.button.default;
    if (typeof size === 'string' && size in scale.button) return scale.button[size];
    return `dynamic size ${String(size)}`;
  }
  if (CONTROLS.has(tag)) {
    if (size !== undefined) return `unexpected size ${String(size)}`;
    return `field ${String(scale.control)}`;
  }
  if (tag === 'ExplainButton') return attribute(open, 'iconOnly') != null ? 8 : 10;
  if (SHARED_TEXT_BUTTON.test(tag)) {
    return typeof size === 'string' && size in scale.button
      ? scale.button[size]
      : scale.button.default;
  }
  if (SHARED_ICON_BUTTON.test(tag)) return scale.button.icon;
  if (WRAPPERS.has(tag) && ts.isJsxElement(node)) {
    const inner = jsxChildren(node, vars);
    if (inner.length === 1 && inner[0] != null) return controlHeight(inner[0], scale, vars);
  }
  return undefined;
}

/** Fields count by their height; the documented field and button pair counts as one. */
function rowKey(height: number | string | undefined, scale: Scale): string {
  const pair = scale.fieldButtonPair;
  if (pair != null) {
    if (height === `field ${String(pair.control)}` || height === pair.button) return 'field row';
  }
  if (typeof height === 'string' && height.startsWith('field ')) return height.slice(6);
  return String(height);
}

/** A container that stacks its children (`space-y-*`, or `flex-col` that never turns into a row). */
function stacksChildren(node: ts.JsxElement): boolean {
  const className = attribute(node.openingElement, 'className');
  if (typeof className !== 'string') return false;
  const classes = className.split(/\s+/);
  const becomesRow = classes.some((c) => /^(?:[a-z0-9]+:)+(?:flex-row|grid-cols-[2-9])$/.test(c));
  if (becomesRow) return false;
  return classes.includes('flex-col') || classes.some((c) => /^space-y-/.test(c));
}

function mixedRows(sources: Record<string, string>, scale: Scale): string[] {
  const found: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const vars = jsxVariables(source);
    const walk = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && !stacksChildren(node)) {
        const controls = jsxChildren(node, vars)
          .map((child) => ({ child, height: controlHeight(child, scale, vars) }))
          .filter((b) => b.height !== undefined);
        if (
          controls.length >= 2 &&
          new Set(controls.map((b) => rowKey(b.height, scale))).size > 1
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const list = controls
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

describe('control rows', () => {
  it('scan the CSMS and portal sources', () => {
    expect(Object.keys(CSMS_SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(PORTAL_SOURCES).length).toBeGreaterThan(30);
  });

  // Each scan parses every source file of the app; under coverage in CI it outgrew the 5 s default.
  it('give the controls of one CSMS row the same height', () => {
    expect(mixedRows(CSMS_SOURCES, CSMS_SCALE)).toEqual([]);
  }, 30_000);

  it('give the controls of one portal row the same height', () => {
    expect(mixedRows(PORTAL_SOURCES, PORTAL_SCALE)).toEqual([]);
  }, 30_000);

  it('flag a field next to a compact button', () => {
    const rows = mixedRows(
      {
        'row.tsx': `export const A = () => (
          <div className="flex gap-2">
            <Input />
            <Button size="xs">Go</Button>
          </div>
        );`,
      },
      CSMS_SCALE,
    );
    expect(rows).toEqual(['row.tsx:2 Input=field 10 Button=7']);
  });

  it('flag a field that still passes a size', () => {
    const rows = mixedRows(
      {
        'row.tsx': `export function A() {
          const search = <SearchInput value="" onDebouncedChange={f} />;
          return (
            <div className="flex gap-2">
              <div className="flex-1">{search}</div>
              <Select size="sm" />
            </div>
          );
        }`,
      },
      CSMS_SCALE,
    );
    expect(rows).toEqual(['row.tsx:4 div=field 10 Select=unexpected size sm']);
  });

  it('accept a CSMS filter bar of fields, buttons and icon buttons at 40 px', () => {
    const rows = mixedRows(
      {
        'row.tsx': `export const A = () => (
          <div className="flex gap-2">
            <SearchInput value="" onDebouncedChange={f} />
            <Select />
            <FilterPopover />
            <Button size="sm">Go</Button>
            <AddIconButton onClick={f} title="Add" />
          </div>
        );`,
      },
      CSMS_SCALE,
    );
    expect(rows).toEqual([]);
  });

  it('skip a stack of full-width buttons', () => {
    const rows = mixedRows(
      {
        'row.tsx': `export const A = () => (
          <div className="space-y-2">
            <Button size="lg" className="w-full">Pay</Button>
            <Button className="w-full">Sign In</Button>
          </div>
        );`,
      },
      PORTAL_SCALE,
    );
    expect(rows).toEqual([]);
  });

  it('accept the portal 40 px button next to a 48 px field, and nothing else', () => {
    const row = (button: string): Record<string, string> => ({
      'row.tsx': `export const A = () => (
        <form className="flex gap-2"><Input />${button}</form>
      );`,
    });
    expect(mixedRows(row('<Button type="submit">Send</Button>'), PORTAL_SCALE)).toEqual([]);
    expect(mixedRows(row('<Button size="sm">Send</Button>'), PORTAL_SCALE)).toEqual([
      'row.tsx:2 Input=field 12 Button=9',
    ]);
    expect(mixedRows(row('<Button type="submit">Send</Button>'), CSMS_SCALE)).toEqual([]);
    expect(
      mixedRows(row('<Button>Send</Button>'), {
        button: PORTAL_SCALE.button,
        control: PORTAL_SCALE.control,
      }),
    ).toEqual(['row.tsx:2 Input=field 12 Button=10']);
  });
});
