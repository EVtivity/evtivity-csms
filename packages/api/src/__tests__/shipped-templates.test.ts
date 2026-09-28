// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { describe, it, expect } from 'vitest';
import { assertTemplateAllowed, compileAllowedTemplate } from '@evtivity/lib';

const TEMPLATES_DIR = fileURLToPath(new URL('../templates', import.meta.url));

function listTemplates(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTemplates(path);
    return entry.name.endsWith('.hbs') ? [path] : [];
  });
}

describe('shipped notification templates', () => {
  const files = listTemplates(TEMPLATES_DIR);

  it('finds the template files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files.map((f) => [relative(TEMPLATES_DIR, f), f]))(
    '%s passes the operator template rules and renders like Handlebars',
    (_name, file) => {
      const source = readFileSync(file, 'utf-8');
      expect(() => {
        assertTemplateAllowed(source);
      }).not.toThrow();
      // Every variable set, then none set, so both sides of each {{#if}} render.
      const names = [...source.matchAll(/\{\{\{?[#^]?(?:if |unless )?\s*([A-Za-z_][\w.]*)/g)]
        .map((m) => m[1] ?? '')
        .filter((n) => n !== 'else' && n !== 'if' && n !== 'unless');
      const all = Object.fromEntries(names.map((n) => [n, `<${n}> & "x"`]));
      for (const vars of [all, {}]) {
        expect(compileAllowedTemplate(source)(vars)).toBe(Handlebars.compile(source)(vars));
      }
    },
  );
});
