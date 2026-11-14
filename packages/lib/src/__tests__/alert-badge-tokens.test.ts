// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Alert variants draw their text with the tone text tokens the theme
// contrast test checks on the tints, and the Badge fills stay opaque, so the
// fill pairs of the theme test hold wherever a badge sits.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe.each(['csms', 'portal'])('%s Alert and Badge tokens', (app) => {
  const alert = readFileSync(
    resolve(repoRoot, `packages/${app}/src/components/ui/alert.tsx`),
    'utf8',
  );
  const badge = readFileSync(
    resolve(repoRoot, `packages/${app}/src/components/ui/badge.tsx`),
    'utf8',
  );

  it('uses the tone text token for every tinted Alert variant', () => {
    for (const tone of ['destructive', 'success', 'warning', 'info']) {
      expect(alert).toContain(`bg-${tone}/10 text-${tone}-text`);
    }
  });

  it('draws the tone Badges on opaque fills', () => {
    expect(badge).not.toMatch(/(?<![:\w-])bg-(success|destructive|warning|info)\/\d+/);
  });
});
