// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { permissionCatalog } from '@evtivity/lib/permissions';

vi.hoisted(() => {
  // The auth store (imported by the nav registry) reads the color scheme when it loads.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

import { NAV_ENTRIES } from '@/navigation/registry';

// Every CSMS source file except tests.
const SOURCES = import.meta.glob<string>(['../../**/*.{ts,tsx}', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const QUOTED = /['"]([^'"]+)['"]/g;

interface Found {
  file: string;
  permission: string;
}

function literalsIn(pattern: RegExp, pick: (m: RegExpExecArray) => string[]): Found[] {
  const found: Found[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    for (const m of src.matchAll(pattern)) {
      for (const permission of pick(m)) found.push({ file, permission });
    }
  }
  return found;
}

const single = (m: RegExpExecArray): string[] => [m[1] ?? ''];
const list = (m: RegExpExecArray): string[] =>
  [...(m[1] ?? '').matchAll(QUOTED)].map((q) => q[1] ?? '');

const FOUND: Found[] = [
  ...literalsIn(/\buseHasPermission\(\s*['"]([^'"]+)['"]\s*\)/g, single),
  ...literalsIn(/\buseHasAnyPermission\(\s*\[([^\]]*)\]\s*\)/g, list),
  ...literalsIn(/\bhasPermissionCheck\([^,()]+,\s*['"]([^'"]+)['"]\s*\)/g, single),
  ...literalsIn(/\brequiredPermission(?:=|:\s*)['"]([^'"]+)['"]/g, single),
];

interface PermissionArg {
  file: string;
  call: string;
  argument: string;
}

/** The top-level comma-separated arguments of the call whose `(` is at `open`. */
function callArguments(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i] as string;
    if (quote != null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i).trim());
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

const STRING_LITERAL = /^(['"])[^'"\\]+\1$/;

/** Exactly one string literal, or an array of string literals. */
function isLiteralArgument(argument: string): boolean {
  if (STRING_LITERAL.test(argument)) return true;
  if (!argument.startsWith('[') || !argument.endsWith(']')) return false;
  const items = argument
    .slice(1, -1)
    .split(',')
    .map((s) => s.trim());
  if (items[items.length - 1] === '') items.pop();
  return items.length > 0 && items.every((s) => STRING_LITERAL.test(s));
}

// Every argument given as a permission: the hook argument, the second argument of
// hasPermissionCheck, a `requiredPermission` property or JSX prop. Function
// definitions and property reads are not arguments.
function permissionArguments(): PermissionArg[] {
  const found: PermissionArg[] = [];
  for (const [file, src] of Object.entries(SOURCES)) {
    for (const m of src.matchAll(/(?<!function\s)\b(useHasPermission|useHasAnyPermission)\(/g)) {
      const open = m.index + m[0].length - 1;
      found.push({ file, call: m[1] ?? '', argument: callArguments(src, open)[0] ?? '' });
    }
    for (const m of src.matchAll(/(?<!function\s)\bhasPermissionCheck\(/g)) {
      const open = m.index + m[0].length - 1;
      found.push({ file, call: 'hasPermissionCheck', argument: callArguments(src, open)[1] ?? '' });
    }
    // Object property (not a type annotation ending in `;`) or JSX prop.
    for (const m of src.matchAll(
      /(?<![.\w])requiredPermission(?::\s*([^;\n]+?),?\s*$|=(?!=)(\{[^}\n]*\}|"[^"\n]*"|'[^'\n]*'))/gm,
    )) {
      let argument = (m[1] ?? m[2] ?? '').trim();
      if (argument.startsWith('{') && argument.endsWith('}'))
        argument = argument.slice(1, -1).trim();
      found.push({ file, call: 'requiredPermission', argument });
    }
  }
  return found;
}

const PERMISSION_ARGS = permissionArguments();

// Dynamic arguments with their own check. Keyed `file: argument`.
const DYNAMIC_ALLOWED = new Set([
  // The hooks pass their own parameter on.
  '../auth.ts: perm',
  '../auth.ts: p',
  // The nav visibility check over each entry's permissions.
  '../../navigation/registry.ts: p',
  // Derived from the permission catalog; the nav entry test below checks every name.
  '../../navigation/registry.ts: SETTINGS_NAV_PERMISSIONS',
  // The Settings tabs check TAB_PERMISSIONS, derived from the permission catalog.
  '../../pages/Settings.tsx: perm',
]);

describe('permission names in the CSMS', () => {
  it('scans the sources', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    // 34 useHasPermission calls and 4 route guards when this test was written.
    expect(FOUND.length).toBeGreaterThanOrEqual(38);
  });

  it('finds every permission argument it checks', () => {
    expect(PERMISSION_ARGS.length).toBeGreaterThanOrEqual(FOUND.length);
    // A concatenation and a variable are not literals.
    expect(isLiteralArgument("'drivers:' + action")).toBe(false);
    expect(isLiteralArgument('permission')).toBe(false);
    expect(isLiteralArgument('[perm, "drivers:read"]')).toBe(false);
    expect(isLiteralArgument('`drivers:${action}`')).toBe(false);
    expect(isLiteralArgument("'drivers:read'")).toBe(true);
    expect(isLiteralArgument('["drivers:read", \'sites:read\',]')).toBe(true);
  });

  it('passes only literals as permissions, so the scan sees every name', () => {
    const dynamic = PERMISSION_ARGS.filter(
      (a) => !isLiteralArgument(a.argument) && !DYNAMIC_ALLOWED.has(`${a.file}: ${a.argument}`),
    ).map((a) => `${a.file}: ${a.call} ${a.argument}`);
    expect(dynamic).toEqual([]);
  });

  it('allows only dynamic arguments that still exist', () => {
    const seen = new Set(PERMISSION_ARGS.map((a) => `${a.file}: ${a.argument}`));
    expect([...DYNAMIC_ALLOWED].filter((key) => !seen.has(key))).toEqual([]);
  });

  it('names only permissions the catalog knows in hooks, guards and tabs', () => {
    const unknown = FOUND.filter((f) => !permissionCatalog.isKnown(f.permission));
    expect(unknown).toEqual([]);
  });

  it('names only permissions the catalog knows in the nav entries', () => {
    const names = NAV_ENTRIES.flatMap((e) =>
      typeof e.requiredPermission === 'string' ? [e.requiredPermission] : [...e.requiredPermission],
    );
    expect(names.length).toBeGreaterThanOrEqual(NAV_ENTRIES.length);
    expect(names.filter((p) => !permissionCatalog.isKnown(p))).toEqual([]);
  });
});
