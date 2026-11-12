// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * Every tab strip is the shared `TabsList` (`components/ui/tabs.tsx`), which
 * scrolls through `ScrollFade` with its edge fades and chevrons only when the
 * tabs do not fit. A wrapper that scrolls, clips or caps the width of a
 * `TabsList` hid tabs with no cue: under Roaming a `<div className="overflow-x-auto">`
 * beside the create button cut tabs off on desktop while the shared fade
 * never showed (owner report 2026-11-11). This guard parses every CSMS and
 * portal source file and fails on
 * - a `TabsList` whose direct parent element, or the `TabsList` itself, has an
 *   `overflow-*` class or a width cap (`max-w-*` other than `max-w-full` or
 *   `max-w-none`, a fixed `w-*`);
 * - a `role="tablist"` outside `components/ui`: a hand-built tab bar.
 * (`frontend/ui.md`, "Tabs".)
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

/** Files allowed a `role="tablist"` outside `components/ui`, with the reason. */
const TABLIST_ALLOWED: Record<string, string> = {
  'components/settings/StationMessageSettings.tsx':
    'a vertical side list beside an editor (frontend/ui.md, "A side list beside an editor"), replaced by a Select on phones; the shared Tabs strip is horizontal only',
};

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

function openingOf(node: JsxNode): ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function tagName(node: JsxNode): string {
  return openingOf(node).tagName.getText();
}

function attribute(node: JsxNode, name: string): ts.JsxAttribute | undefined {
  return openingOf(node).attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

/** Every string literal in the `className` of an element (a plain string or `cn(...)` arguments). */
function classNames(node: JsxNode): string[] {
  const attr = attribute(node, 'className');
  if (attr?.initializer == null) return [];
  const classes: string[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      classes.push(...n.text.split(/\s+/).filter((c) => c.length > 0));
    } else if (ts.isTemplateExpression(n)) {
      classes.push(...n.head.text.split(/\s+/));
      for (const span of n.templateSpans) {
        collect(span.expression);
        classes.push(...span.literal.text.split(/\s+/));
      }
    }
    ts.forEachChild(n, collect);
  };
  collect(attr.initializer);
  return classes.filter((c) => c.length > 0);
}

/** A class that scrolls, clips or caps the width of a tab strip. */
export function isStripBreakingClass(cls: string): boolean {
  const base = cls.split(':').pop() ?? cls;
  if (/^overflow(-[xy])?-/.test(base)) return true;
  if (/^max-w-/.test(base)) return base !== 'max-w-full' && base !== 'max-w-none';
  if (/^w-/.test(base)) return !['w-full', 'w-auto'].includes(base);
  return false;
}

/** Every `<file>:<line> <reason>` of a strip that breaks the standard. */
export function tabStripOffenders(file: string, src: string): string[] {
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const lineOf = (node: ts.Node): string =>
    String(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
  const allowTablist = Object.keys(TABLIST_ALLOWED).some((f) => file.endsWith(f));
  const inUi = /(^|\/)components\/ui\//.test(file);

  const visit = (node: ts.Node, parent: JsxNode | null): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const role = attribute(node, 'role')?.initializer;
      if (!inUi && !allowTablist && role != null && ts.isStringLiteral(role)) {
        if (role.text === 'tablist') offenders.push(`${file}:${lineOf(node)} role="tablist"`);
      }
      if (tagName(node) === 'TabsList') {
        const own = classNames(node).filter(isStripBreakingClass);
        if (own.length > 0) offenders.push(`${file}:${lineOf(node)} TabsList ${own.join(' ')}`);
        if (parent != null) {
          const wrap = classNames(parent).filter(isStripBreakingClass);
          if (wrap.length > 0) {
            offenders.push(`${file}:${lineOf(node)} TabsList wrapper ${wrap.join(' ')}`);
          }
        }
      }
      if (ts.isJsxElement(node)) {
        for (const child of node.children) visit(child, node);
        return;
      }
    }
    // A fragment or an expression between two elements keeps the nearest element as the parent.
    ts.forEachChild(node, (child) => {
      visit(child, ts.isJsxFragment(node) ? null : parent);
    });
  };
  visit(source, null);
  return offenders;
}

describe('tab strips use the shared TabsList without a clipping wrapper', () => {
  it('scans the CSMS and portal sources', () => {
    expect(Object.keys(CSMS_SOURCES).length).toBeGreaterThan(200);
    expect(Object.keys(PORTAL_SOURCES).length).toBeGreaterThan(30);
  });

  it('flags overflow and width caps, not full width', () => {
    expect(isStripBreakingClass('overflow-x-auto')).toBe(true);
    expect(isStripBreakingClass('md:overflow-hidden')).toBe(true);
    expect(isStripBreakingClass('lg:max-w-[80%]')).toBe(true);
    expect(isStripBreakingClass('w-64')).toBe(true);
    expect(isStripBreakingClass('max-w-full')).toBe(false);
    expect(isStripBreakingClass('w-full')).toBe(false);
    expect(isStripBreakingClass('min-w-0')).toBe(false);
    expect(isStripBreakingClass('flex-1')).toBe(false);
  });

  it('finds a scrolling wrapper, a capped strip and a hand-built tablist', () => {
    const src = `
      const A = () => (
        <div className="flex"><div className="overflow-x-auto"><TabsList /></div></div>
      );
      const B = () => <TabsList className={cn('max-w-sm')} />;
      const C = () => <div role="tablist"><button role="tab" /></div>;
      const D = () => <div className="min-w-0 flex-1"><TabsList /></div>;
    `;
    expect(tabStripOffenders('pages/X.tsx', src)).toEqual([
      'pages/X.tsx:3 TabsList wrapper overflow-x-auto',
      'pages/X.tsx:5 TabsList max-w-sm',
      'pages/X.tsx:6 role="tablist"',
    ]);
  });

  // Parses every CSMS and portal source file: it took 7 s under coverage in CI,
  // past the 5 s default.
  it('finds no strip that breaks the standard', { timeout: 30_000 }, () => {
    const offenders = [
      ...Object.entries(CSMS_SOURCES).map(([f, s]) => tabStripOffenders(f, s)),
      ...Object.entries(PORTAL_SOURCES).map(([f, s]) => tabStripOffenders(`portal:${f}`, s)),
    ].flat();
    expect(offenders).toEqual([]);
  });

  it('keeps the shared TabsList free of a width cap', () => {
    const tabs = CSMS_SOURCES['../../components/ui/tabs.tsx'] ?? '';
    expect(tabs).toContain('const TabsList');
    expect(tabs).not.toMatch(/max-w-\[/);
  });

  it('lists only allowed files that still hold a tablist', () => {
    for (const file of Object.keys(TABLIST_ALLOWED)) {
      const src = CSMS_SOURCES[`../../${file}`] ?? '';
      expect(src, file).toContain('role="tablist"');
    }
  });
});
