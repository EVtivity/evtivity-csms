// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Every pick-from-a-list control in the CSMS and the portal is a shared
// component: `Select` (a short fixed list), `Combobox` (free text with
// suggestions) or, in the CSMS, `SearchCombobox` and the pickers built on it
// (`StationCombobox`, `DriverCombobox`). This scans the frontend source and
// fails on a raw <select>, a <datalist>, a hand-built listbox, a third-party
// select library, or a `Select` restyled with its own height, padding or text
// size, so every select control keeps one look.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PACKAGES_DIR = path.resolve(import.meta.dirname, '../../..');
const FRONTEND_SRC = ['csms/src', 'portal/src'];

// Files allowed to render the raw element or role, each with the reason.
const ALLOWED: Record<string, { pattern: RegExp; reason: string }[]> = {
  'csms/src/components/ui/select.tsx': [
    { pattern: /<select\b/, reason: 'the shared Select itself' },
  ],
  'portal/src/components/ui/select.tsx': [
    { pattern: /<select\b/, reason: 'the shared Select itself' },
  ],
  'csms/src/components/ui/combobox.tsx': [
    { pattern: /role="listbox"/, reason: 'the shared Combobox itself' },
  ],
  'portal/src/components/ui/combobox.tsx': [
    { pattern: /role="listbox"/, reason: 'the shared Combobox itself' },
  ],
  'csms/src/components/ui/search-combobox.tsx': [
    { pattern: /role="listbox"/, reason: 'the shared SearchCombobox itself' },
  ],
};

const FORBIDDEN: { pattern: RegExp; use: string }[] = [
  { pattern: /<select\b/, use: 'the shared Select (components/ui/select.tsx)' },
  { pattern: /<datalist\b/, use: 'the shared Combobox (components/ui/combobox.tsx)' },
  {
    pattern: /role="listbox"/,
    use: 'the shared Combobox or SearchCombobox instead of a hand-built list',
  },
  {
    pattern:
      /from\s+'(react-select|downshift|cmdk|@headlessui\/react|@radix-ui\/react-select|@radix-ui\/react-popover)'/,
    use: 'the shared Select, Combobox or SearchCombobox instead of a select library',
  },
];

// A `Select` keeps the shared height, padding and text size: only width,
// layout and spacing classes may be passed (`w-auto` in a filter bar).
const SELECT_STYLE_OVERRIDE =
  /(^|\s)(h-\S+|min-h-\S+|p[xytrbl]?-\S+|text-(xs|sm|base|lg)|leading-\S+)(\s|$)/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...sourceFiles(full));
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

// The className of each `<Select ...>` opening tag.
function selectClassNames(source: string): { line: number; className: string }[] {
  const found: { line: number; className: string }[] = [];
  const tagStart = /<Select\b/g;
  let match: RegExpExecArray | null;
  while ((match = tagStart.exec(source)) != null) {
    let depth = 0;
    let end = source.length;
    for (let i = match.index + match[0].length; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) {
        end = i;
        break;
      }
    }
    const tag = source.slice(match.index, end);
    const cls = /className="([^"]*)"/.exec(tag);
    if (cls?.[1] != null) {
      found.push({ line: lineOf(source, match.index), className: cls[1] });
    }
  }
  return found;
}

const files = FRONTEND_SRC.flatMap((dir) => sourceFiles(path.join(PACKAGES_DIR, dir)));

describe('select controls use the shared components', () => {
  it('scans the frontend source', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no raw select, datalist, hand-built listbox or select library', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES_DIR, file);
      const source = readFileSync(file, 'utf8');
      const allowed = ALLOWED[rel] ?? [];
      for (const { pattern, use } of FORBIDDEN) {
        if (allowed.some((a) => a.pattern.source === pattern.source)) continue;
        const global = new RegExp(pattern.source, 'g');
        let match: RegExpExecArray | null;
        while ((match = global.exec(source)) != null) {
          offenders.push(`${rel}:${String(lineOf(source, match.index))} use ${use}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('passes no height, padding or text size to a Select', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES_DIR, file);
      const source = readFileSync(file, 'utf8');
      if (!/\bSelect\b/.test(source)) continue;
      for (const { line, className } of selectClassNames(source)) {
        if (SELECT_STYLE_OVERRIDE.test(className)) {
          offenders.push(`${rel}:${String(line)} className="${className}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every allowlist entry in use', () => {
    const stale: string[] = [];
    for (const [rel, entries] of Object.entries(ALLOWED)) {
      const source = readFileSync(path.join(PACKAGES_DIR, rel), 'utf8');
      for (const { pattern, reason } of entries) {
        if (!pattern.test(source)) stale.push(`${rel} (${reason})`);
      }
    }
    expect(stale).toEqual([]);
  });
});
