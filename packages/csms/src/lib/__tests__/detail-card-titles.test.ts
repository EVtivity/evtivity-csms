// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import en from '../../i18n/locales/en.json';

/**
 * Detail page card titles name whose fields a card shows (owner rule
 * 2026-10-27): the card holding the page entity's own fields is "Details",
 * a card showing another entity's fields is "<Entity> Details". A title such
 * as "Fleet Detail", "Station Info", "Overview" or a bare "Station" fails.
 * Page headings (h1) are not cards and are not checked.
 *
 * Scope: every file a `pages/*Detail.tsx` page imports, up to three levels
 * deep. Checked titles: the `title` of a `TabPanel` and the text of a
 * `CardTitle`, when they come from `t('<key>')`.
 */

const SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const FILES = new Map<string, string>(
  Object.entries(SOURCES).map(([key, text]) => [key.replace(/^\.\.\/\.\.\//, ''), text]),
);

/** Entities a card may name in "<Entity> Details". */
const ENTITIES = [
  'Station',
  'Driver',
  'Vehicle',
  'Session',
  'Guest Session',
  'Token',
  'Site',
  'Fleet',
  'User',
  'Reservation',
  'SIM',
  'Invoice',
  'Tariff',
  'Pricing Group',
  'Tariff Mapping',
  'Template',
  'Campaign',
  'Partner',
  'Support Case',
  'Charging Profile',
  'EVSE',
  'Connector',
];

/** Title keys left as they are, with the reason (each one is in the rule's open list). */
const ALLOWED: Record<string, string> = {
  'reservations.sessionTab':
    'the first card of the Reservation Session tab carries the tab label (TabPanel rule)',
  'sessions.guestSessionTab':
    'the first card of the Session Guest Session tab carries the tab label (TabPanel rule)',
};

const ENTITY_DETAIL = /\b(Details?|Info|Information|Overview)$/;
const ALLOWED_TITLES = new Set(['Details', ...ENTITIES.map((e) => `${e} Details`)]);

function joinPath(fromFile: string, spec: string): string {
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

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

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    FILES.get(file) ?? '',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function detailFiles(): Set<string> {
  const seen = new Set<string>();
  let level = [...FILES.keys()].filter((f) => /^pages\/[A-Za-z]+Detail\.tsx$/.test(f));
  for (let depth = 0; depth <= 3 && level.length > 0; depth++) {
    const next: string[] = [];
    for (const file of level) {
      if (seen.has(file) || file.startsWith('components/ui/')) continue;
      seen.add(file);
      for (const match of (FILES.get(file) ?? '').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const target = match[1] != null ? resolveModule(file, match[1]) : undefined;
        if (target != null && !seen.has(target)) next.push(target);
      }
    }
    level = next;
  }
  return seen;
}

function translation(key: string): string | undefined {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function tKeys(node: ts.Node): string[] {
  const keys: string[] = [];
  const walk = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 't' &&
      n.arguments[0] != null &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      keys.push(n.arguments[0].text);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return keys;
}

/** `file: key = text` for every card title key in the detail page files. */
function cardTitles(): { where: string; key: string; text: string }[] {
  const out: { where: string; key: string; text: string }[] = [];
  for (const file of detailFiles()) {
    const source = parse(file);
    const add = (node: ts.Node, keys: string[]): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      for (const key of keys) {
        out.push({ where: `${file}:${String(line)}`, key, text: translation(key) ?? '' });
      }
    };
    const walk = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(source) === 'TabPanel'
      ) {
        for (const attr of node.attributes.properties) {
          if (
            ts.isJsxAttribute(attr) &&
            attr.name.getText(source) === 'title' &&
            attr.initializer
          ) {
            add(attr, tKeys(attr.initializer));
          }
        }
      }
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'CardTitle') {
        add(
          node,
          node.children.flatMap((child) => tKeys(child)),
        );
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return out;
}

describe('detail page card titles', () => {
  const titles = cardTitles();

  it('scans the detail pages and their tab components', () => {
    expect(titles.some((t) => t.where.startsWith('components/session/SessionDetailsTab.tsx'))).toBe(
      true,
    );
    expect(titles.length).toBeGreaterThan(50);
  });

  it('titles an entity detail card "Details" or "<Entity> Details"', () => {
    const bad = titles
      .filter(({ key }) => ALLOWED[key] == null)
      .filter(({ text }) => !ALLOWED_TITLES.has(text))
      .filter(({ text }) => ENTITY_DETAIL.test(text) || ENTITIES.includes(text))
      .map(({ where, key, text }) => `${where} ${key} = "${text}"`);
    expect(bad).toEqual([]);
  });

  it('keeps the allow list current', () => {
    const used = new Set(titles.map((t) => t.key));
    expect(Object.keys(ALLOWED).filter((key) => !used.has(key))).toEqual([]);
  });
});
