// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Notices and save feedback look the same everywhere in the CSMS and the
// portal (frontend/ui.md, "Notices" and "Save feedback"). This scans the
// frontend source and fails on:
// - a hand-built notice box (a class list with a status border and a status
//   background) instead of the shared `Alert`;
// - an `Alert` whose leading icon is not the one of its variant (info `Info`,
//   warning `AlertTriangle`, destructive `AlertCircle`, success
//   `CheckCircle2`);
// - the brand logo loader (`Spinner`) inside a button: a pending button shows
//   `ButtonPendingLabel` or `ButtonSpinner`;
// - a hand-built inline save success message instead of `SavedMessage`.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PACKAGES_DIR = path.resolve(import.meta.dirname, '../../..');
const FRONTEND_SRC = ['csms/src', 'portal/src'];

const VARIANT_ICON: Record<string, string> = {
  info: 'Info',
  warning: 'AlertTriangle',
  destructive: 'AlertCircle',
  success: 'CheckCircle2',
};
const STATUS_ICONS = new Set(Object.values(VARIANT_ICON));

// Status-colored boxes that are not notices, each with the reason.
const BOX_ALLOWED: Record<string, string> = {
  'csms/src/components/load-management/PowerBar.tsx': 'a bar segment of the power chart',
  'csms/src/components/ai/ConfirmActionCard.tsx': 'the AI confirm card itself',
  'portal/src/pages/Home.tsx': 'the active session card',
};

// Spinners inside a button that mark loading of content, not a button action.
const SPINNER_ALLOWED: Record<string, string> = {
  'csms/src/components/StationImages.tsx': 'a thumbnail loading inside its button',
  'csms/src/components/ai/ToolSteps.tsx': 'a running AI tool inside its expand toggle',
};

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...sourceFiles(full));
      }
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_line, lead: string) => lead);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** The end of the JSX tag that starts at `start`, and whether it closes itself. */
function tagEnd(source: string, start: number): { end: number; selfClosing: boolean } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote != null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return { end: i, selfClosing: source[i - 1] === '/' };
  }
  return { end: source.length, selfClosing: false };
}

/** Indexes of `<Spinner` tags inside a `Button` or `button` element. */
function spinnersInButtons(source: string, forceButton: boolean): number[] {
  const re = /<\/?(Button|button)\b|<Spinner\b/g;
  let depth = 0;
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) != null) {
    if (m[0].startsWith('</')) depth = Math.max(0, depth - 1);
    else if (m[0] === '<Spinner') {
      if (depth > 0 || forceButton) hits.push(m.index);
    } else if (!tagEnd(source, m.index).selfClosing) depth++;
  }
  return hits;
}

/** Each `<Alert` with its literal variant (or `dynamic`) and its first child component. */
function alertsOf(source: string): { index: number; variant: string; icon: string }[] {
  const out: { index: number; variant: string; icon: string }[] = [];
  const re = /<Alert\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) != null) {
    const { end } = tagEnd(source, m.index);
    const open = source.slice(m.index, end + 1);
    const literal = /variant="([a-z]+)"/.exec(open)?.[1];
    const variant = literal ?? (/variant=\{/.test(open) ? 'dynamic' : 'default');
    const close = source.indexOf('</Alert>', end);
    const body = source.slice(end + 1, close === -1 ? undefined : close);
    const icon = /<([A-Z][A-Za-z0-9]*)\b/.exec(body)?.[1] ?? '';
    out.push({ index: m.index, variant, icon });
  }
  return out;
}

const STATUS = '(?:warning|info|destructive|success)';
const BOX = new RegExp(
  `className="[^"]*\\bborder-${STATUS}\\b[^"]*\\bbg-${STATUS}\\/|className="[^"]*\\bbg-${STATUS}\\/[^"]*\\bborder-${STATUS}\\b|<Card className="[^"]*\\bborder-${STATUS}\\b`,
  'g',
);
const INLINE_SAVED =
  /<p className="text-sm text-success"[^>]*>\s*\{t\('[^']*[sS]aved[^']*'\)\}\s*<\/p>/g;

const files = FRONTEND_SRC.flatMap((dir) => sourceFiles(path.join(PACKAGES_DIR, dir)));
const isShared = (rel: string): boolean =>
  /\/components\/ui\//.test(rel) || /\/saved-message\.tsx$/.test(rel);

describe('notices and save feedback use the shared components', () => {
  it('scans the frontend source', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('reads samples the way the scans expect', () => {
    expect(
      spinnersInButtons('<Button className="relative"><Spinner /></Button>', false),
    ).toHaveLength(1);
    expect(spinnersInButtons('<Button onClick={() => {}} /><div><Spinner /></div>', false)).toEqual(
      [],
    );
    expect(alertsOf('<Alert variant="warning">\n<AlertTriangle className="h-4 w-4" />')[0]).toEqual(
      {
        index: 0,
        variant: 'warning',
        icon: 'AlertTriangle',
      },
    );
    expect(
      '<div className="rounded-md border border-warning/40 bg-warning/10 p-3">'.match(BOX),
    ).not.toBeNull();
    expect(
      '<p className="text-sm text-success">{t(\'common.saved\')}</p>'.match(INLINE_SAVED),
    ).not.toBeNull();
  });

  it('builds no notice box by hand', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES_DIR, file);
      if (isShared(rel)) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const m of source.matchAll(BOX)) {
        if (BOX_ALLOWED[rel] != null) continue;
        offenders.push(`${rel}:${String(lineOf(source, m.index))} use the shared Alert`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every Alert the icon of its variant', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES_DIR, file);
      if (isShared(rel)) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const { index, variant, icon } of alertsOf(source)) {
        const at = `${rel}:${String(lineOf(source, index))}`;
        if (variant === 'default') offenders.push(`${at} give the Alert a variant`);
        else if (variant === 'dynamic') {
          if (!STATUS_ICONS.has(icon)) offenders.push(`${at} lead with a status icon, not ${icon}`);
        } else if (icon !== VARIANT_ICON[variant]) {
          offenders.push(
            `${at} ${variant} leads with ${String(VARIANT_ICON[variant])}, not ${icon}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('shows no logo loader inside a button', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES_DIR, file);
      if (/\/components\/ui\/spinner\.tsx$/.test(rel) || SPINNER_ALLOWED[rel] != null) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      const force = /-button\.tsx$/.test(rel) || /\/components\/ui\/confirm-dialog\.tsx$/.test(rel);
      for (const index of spinnersInButtons(source, force)) {
        offenders.push(
          `${rel}:${String(lineOf(source, index))} use ButtonPendingLabel or ButtonSpinner`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('shows inline save success through SavedMessage', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES_DIR, file);
      if (isShared(rel)) continue;
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const m of source.matchAll(INLINE_SAVED)) {
        offenders.push(`${rel}:${String(lineOf(source, m.index))} use SavedMessage`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every allowlist entry in use', () => {
    const stale: string[] = [];
    for (const rel of Object.keys(SPINNER_ALLOWED)) {
      const source = readFileSync(path.join(PACKAGES_DIR, rel), 'utf8');
      if (!/<Spinner\b/.test(source)) stale.push(rel);
    }
    for (const rel of Object.keys(BOX_ALLOWED)) {
      const source = withoutComments(readFileSync(path.join(PACKAGES_DIR, rel), 'utf8'));
      if ([...source.matchAll(BOX)].length === 0) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });
});
