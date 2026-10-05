// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// `npm run db:seed -- --apply-config` (scripts/docker-build.sh after a wipe)
// appends the flag to the root script's command. Without a trailing `--` the
// nested `npm run seed` reads `--apply-config` as an npm config flag ("Unknown
// cli config") and seed.ts never sees it, so seed.config.json was not applied.
describe('root db:seed script', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };

  it('forwards its arguments to seed.ts', () => {
    expect(pkg.scripts['db:seed']).toBe('npm run seed --workspace=@evtivity/database --');
  });
});
