// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { assertTemplateAllowed } from '@evtivity/lib';

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
    '%s passes the operator template rules',
    (_name, file) => {
      expect(() => {
        assertTemplateAllowed(readFileSync(file, 'utf-8'));
      }).not.toThrow();
    },
  );
});
