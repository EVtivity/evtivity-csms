// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { LOAD_ALLOCATION_REASONS } from '@evtivity/lib/load-allocation-reasons';

const release = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '0492_release_0_1_53.sql'),
  'utf8',
);

describe('LOAD_ALLOCATION_REASONS', () => {
  it('is the reason list of the load_allocation_entries CHECK', () => {
    const check = /"load_allocation_entries_reason_check"\s+CHECK \("reason" IN \(([^)]*)\)\)/.exec(
      release,
    );
    expect(check?.[1]).toBeDefined();
    const migrated = [...(check?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(migrated).toEqual([...LOAD_ALLOCATION_REASONS]);
  });

  it('fits the reason column', () => {
    for (const reason of LOAD_ALLOCATION_REASONS) expect(reason.length).toBeLessThanOrEqual(20);
  });
});
