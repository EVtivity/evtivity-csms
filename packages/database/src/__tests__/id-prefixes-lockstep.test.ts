// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { ID_PREFIXES as LIB_PREFIXES } from '@evtivity/lib';
import { ID_PREFIXES as DATABASE_PREFIXES } from '../lib/id.js';

// The schema ids (createId) and the application ids (generateId) must name
// every entity with the same prefix: a missing entry fails generateId's type
// in app code, a different prefix mints ids the other side does not expect.
describe('id prefixes', () => {
  it('match between @evtivity/database and @evtivity/lib', () => {
    expect(LIB_PREFIXES).toEqual(DATABASE_PREFIXES);
  });
});
