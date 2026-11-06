// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * Fields on one row are top aligned (owner rule 2026-11-04, `frontend/ui.md`,
 * "Form layout"). A grid row stretches its cells to the tallest one, so a field
 * (`grid gap-2`: label, control, helper text) next to a field with helper text
 * spread its own rows and its control sat lower than its neighbour's (the bus
 * depot system dialog). The row carries `items-start`. This guard parses every
 * CSMS and portal source file with the TypeScript compiler API and fails on a
 * multi-column grid (`grid-cols-2` and up, any breakpoint, or an arbitrary
 * `grid-cols-[...]`) with at least two children that each hold a `Label`,
 * unless the grid has `items-start` (or `content-start`), or every such child
 * has `self-start` or `content-start`.
 */

const CSMS_SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const PORTAL_SOURCES = import.meta.glob<string>(
  ['../../../../portal/src/**/*.tsx', '!**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
);

/** Rows that align their fields another way on purpose, by file and class, with the reason. */
const ALLOWED: Record<string, { cls: string; reason: string }> = {
  '../../components/reports/NeviComplianceTab.tsx': {
    cls: 'grid grid-cols-2 items-end gap-4 sm:flex sm:flex-wrap',
    reason:
      'Quarter and Year (labels of one line, no helper text) with the Generate button: items-end lines the button up with the controls',
  },
  '../../components/layout/LayoutReplayBar.tsx': {
    cls: 'sm:grid-cols-[auto_1fr_auto] sm:items-center',
    reason: 'the replay toolbar: play controls, slider and time on one centered line',
  },
};

const MULTI_COLUMN = /(?:^|\s|:)grid-cols-(?:[2-9]|1[0-2]|\[)/;
const TOP_ROW = /(?:^|\s|:)(?:items-start|content-start)(?:\s|$)/;
const TOP_CELL = /(?:^|\s|:)(?:self-start|content-start)(?:\s|$)/;

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;
const isJsx = (n: ts.Node): n is JsxNode => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);
const openingOf = (n: JsxNode): ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
  ts.isJsxElement(n) ? n.openingElement : n;

/** The className text: a string literal's value, else the expression's source. */
function classNameOf(n: JsxNode): string {
  for (const p of openingOf(n).attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== 'className' || p.initializer == null) {
      continue;
    }
    return ts.isStringLiteral(p.initializer) ? p.initializer.text : p.initializer.getText();
  }
  return '';
}

function holdsLabel(node: ts.Node): boolean {
  if (isJsx(node) && /^(?:Label|label)$/.test(openingOf(node).tagName.getText())) return true;
  return ts.forEachChild(node, (c) => (holdsLabel(c) ? true : undefined)) === true;
}

/** Every `<file>:<line> <className>` of a field row whose fields are not top aligned. */
export function misalignedFieldRows(file: string, src: string): string[] {
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const cls = classNameOf(node);
      if (MULTI_COLUMN.test(cls) && !TOP_ROW.test(cls)) {
        let fields = 0;
        let topFields = 0;
        for (const child of node.children) {
          if (isJsx(child) && holdsLabel(child)) {
            fields += 1;
            if (TOP_CELL.test(classNameOf(child))) topFields += 1;
          } else if (ts.isJsxExpression(child) && holdsLabel(child)) {
            // A list rendered with map() puts several fields on the row.
            fields += /\.map\(/.test(child.getText()) ? 2 : 1;
          }
        }
        const allowed = ALLOWED[file];
        if (fields >= 2 && topFields < fields && !(allowed != null && cls.includes(allowed.cls))) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          offenders.push(`${file}:${String(line + 1)} ${cls}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe('fields on one row are top aligned', () => {
  it('scans the CSMS and portal sources', () => {
    expect(Object.keys(CSMS_SOURCES).length).toBeGreaterThan(200);
    expect(Object.keys(PORTAL_SOURCES).length).toBeGreaterThan(30);
  });

  it('finds a field row without top alignment and accepts the aligned forms', () => {
    const src = `
      const A = () => (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label>A</Label><Input /></div>
            <div className="grid gap-2"><Label>B</Label><Input /><p>Help</p></div>
          </div>
          <div className={cn('grid md:grid-cols-3 gap-4', x)}>
            {fields.map((f) => <div key={f}><Label>{f}</Label><Input /></div>)}
          </div>
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label>A</Label><Input /></div>
            <div className="grid gap-2"><Label>B</Label><Input /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid content-start gap-2"><Label>A</Label><Input /></div>
            <div className="grid content-start gap-2"><Label>B</Label><Input /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2"><Label>A</Label><Input /></div>
            <Button>Go</Button>
          </div>
        </>
      );
    `;
    expect(misalignedFieldRows('x.tsx', src)).toEqual([
      'x.tsx:4 grid grid-cols-1 gap-4 sm:grid-cols-2',
      "x.tsx:8 {cn('grid md:grid-cols-3 gap-4', x)}",
    ]);
  });

  // Parses every CSMS and portal source file: under coverage on a CI runner it
  // can take longer than the 5 s default.
  it('keeps every field row of the CSMS and the portal top aligned', { timeout: 60_000 }, () => {
    const offenders = Object.entries({ ...CSMS_SOURCES, ...PORTAL_SOURCES }).flatMap(
      ([file, src]) =>
        src.includes('Label') || src.includes('<label') ? misalignedFieldRows(file, src) : [],
    );
    expect(offenders).toEqual([]);
  });

  it('allows only rows that exist', () => {
    for (const [file, { cls }] of Object.entries(ALLOWED)) {
      expect(CSMS_SOURCES[file], file).toContain(cls);
    }
  });
});
