// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Every date, time and date-time field in the CSMS and the portal is a shared
// component: `DateInput` (a day), `TimeInput` (a time of day), `DateTimeInput`
// (a day and a time) and, in the CSMS, `MonthPicker` (a month). This scans the
// frontend source and fails on a native date, time, date-time, month or week
// input (`type="date"` and the others, on any element, the shared `Input`
// included), a third-party date picker library, or a hand-built calendar grid,
// so every date control opens the same calendar and time selects.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const PACKAGES_DIR = path.resolve(import.meta.dirname, '../../..');
const FRONTEND_SRC = ['csms/src', 'portal/src'];

// Files allowed to render the element or role, each with the reason.
const ALLOWED: Record<string, { pattern: RegExp; reason: string }[]> = {
  'csms/src/components/ui/date-input.tsx': [
    { pattern: /role="grid"/, reason: 'the shared DateInput calendar itself' },
  ],
  'portal/src/components/ui/date-input.tsx': [
    { pattern: /role="grid"/, reason: 'the shared DateInput calendar itself' },
  ],
};

const FORBIDDEN: { pattern: RegExp; use: string }[] = [
  {
    pattern: /\btype=(?:"date"|'date'|\{\s*['"]date['"]\s*\})/,
    use: 'the shared DateInput (components/ui/date-input.tsx)',
  },
  {
    pattern: /\btype=(?:"datetime-local"|'datetime-local'|\{\s*['"]datetime-local['"]\s*\})/,
    use: 'the shared DateTimeInput (components/ui/date-time-input.tsx)',
  },
  {
    pattern: /\btype=(?:"time"|'time'|\{\s*['"]time['"]\s*\})/,
    use: 'the shared TimeInput (components/ui/time-input.tsx)',
  },
  {
    pattern: /\btype=(?:"(?:month|week)"|'(?:month|week)'|\{\s*['"](?:month|week)['"]\s*\})/,
    use: 'the shared MonthPicker (CSMS components/ui/month-picker.tsx) or DateInput',
  },
  {
    pattern: /role="grid"/,
    use: 'the shared DateInput instead of a hand-built calendar grid',
  },
  {
    pattern:
      /from\s+'(react-day-picker|react-datepicker|react-date-picker|react-date-range|react-calendar|flatpickr|react-flatpickr|@mui\/x-date-pickers[^']*|@react-aria\/datepicker|@internationalized\/date|vanillajs-datepicker|pikaday)'/,
    use: 'the shared DateInput, TimeInput or DateTimeInput instead of a date picker library',
  },
];

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

// Comments name the native inputs the shared components replace; blank them
// (keeping the line breaks, so line numbers stay) before the scan.
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (line, lead: string) => lead);
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

const files = FRONTEND_SRC.flatMap((dir) => sourceFiles(path.join(PACKAGES_DIR, dir)));

describe('date and time controls use the shared components', () => {
  it('scans the frontend source', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds a native date input in a sample', () => {
    const sample = withoutComments(
      '// <input type="date"> in a comment\n<Input\n  id="d"\n  type="date"\n/>',
    );
    expect(FORBIDDEN[0]?.pattern.test(sample)).toBe(true);
    expect(lineOf(sample, sample.indexOf('type="date"'))).toBe(4);
    expect(FORBIDDEN[0]?.pattern.test(withoutComments('// type="date"'))).toBe(false);
  });

  it('has no native date or time input, calendar grid or date picker library', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(PACKAGES_DIR, file);
      const source = withoutComments(readFileSync(file, 'utf8'));
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
