// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * A `TabPanel` with `isEmpty` (or `isLoading`, `isError`) shows the content
 * state instead of its children (`components/ui/tab-panel.tsx`,
 * `contentState`). A dialog or form rendered among those children disappears
 * with them, so an add action available on an empty list opened nothing: the
 * first battery of a site could never be added (v0.1.50). Dialogs and open
 * forms go next to the `TabPanel`, never inside its children
 * (`frontend/ui.md`, "Tab panels"). This guard parses every CSMS and portal
 * source file and fails on a `Dialog`, a `ConfirmDialog`, or any element whose
 * tag ends in `Dialog` or `Form` with an `open` prop, inside the children of a
 * `TabPanel` that has an `isEmpty` prop.
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

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function openingOf(node: JsxNode): ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function tagName(node: JsxNode): string {
  return openingOf(node).tagName.getText();
}

function hasProp(node: JsxNode, name: string): boolean {
  return openingOf(node).attributes.properties.some(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

/** A dialog or an open form that a content state would hide. */
export function isHiddenOverlay(node: JsxNode): boolean {
  const tag = tagName(node).split('.').pop() ?? '';
  if (tag === 'Dialog' || tag === 'ConfirmDialog') return true;
  return (tag.endsWith('Dialog') || tag.endsWith('Form')) && hasProp(node, 'open');
}

/** Every `<file>:<line> <tag>` of an overlay inside a `TabPanel isEmpty` body. */
export function tabPanelOverlayOffenders(file: string, src: string): string[] {
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const scan = (node: ts.Node): void => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && isHiddenOverlay(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      offenders.push(`${file}:${String(line + 1)} ${tagName(node)}`);
    }
    ts.forEachChild(node, scan);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && tagName(node) === 'TabPanel' && hasProp(node, 'isEmpty')) {
      for (const child of node.children) scan(child);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe('no dialog inside the body of an empty-capable TabPanel', () => {
  it('scans the CSMS and portal sources', () => {
    expect(Object.keys(CSMS_SOURCES).length).toBeGreaterThan(200);
    expect(Object.keys(PORTAL_SOURCES).length).toBeGreaterThan(30);
  });

  it('finds an overlay inside the children, not in the actions or next to the panel', () => {
    const bad = `
      const A = () => (
        <TabPanel isEmpty={rows.length === 0} actions={<ConfirmDialog open={x} />}>
          <Table />
          {adding && <AssetForm open={adding} />}
          <div><Dialog open={open} /></div>
          <SiteForm />
        </TabPanel>
      );
      const B = () => (
        <>
          <TabPanel isEmpty>
            <Table />
          </TabPanel>
          <Dialog open={open} />
        </>
      );
      const C = () => <TabPanel><ConfirmDialog open={x} /></TabPanel>;
    `;
    expect(tabPanelOverlayOffenders('x.tsx', bad)).toEqual(['x.tsx:5 AssetForm', 'x.tsx:6 Dialog']);
  });

  // Parses every CSMS and portal source file: under coverage on a CI runner it
  // can take longer than the 5 s default.
  it('keeps every dialog out of an empty-capable TabPanel body', { timeout: 30_000 }, () => {
    const offenders = Object.entries({ ...CSMS_SOURCES, ...PORTAL_SOURCES }).flatMap(
      ([file, src]) => (src.includes('TabPanel') ? tabPanelOverlayOffenders(file, src) : []),
    );
    expect(offenders).toEqual([]);
  });
});
