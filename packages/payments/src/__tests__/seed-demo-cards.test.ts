// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { REBILL_DEMO_METHOD_ID } from '@evtivity/database/src/seed-demo-cards.js';
import { parseMethodId } from '../providers/simulated/ids.js';

describe('seeded demo cards', () => {
  it('seeds the re-bill demo driver an always-approved simulated card', () => {
    expect(parseMethodId(REBILL_DEMO_METHOD_ID)).toEqual({ scenario: 'approve', last4: '4242' });
  });
});
