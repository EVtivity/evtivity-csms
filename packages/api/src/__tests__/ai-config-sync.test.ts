// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { AI_EFFORTS, AI_PROVIDER_IDS } from '@evtivity/lib/ai-config';
import { EFFORTS, PROVIDER_IDS } from '../services/ai/core/types.js';
import { listProviderEntries } from '../services/ai/core/model-registry.js';

// The settings layer (@evtivity/lib/ai-config) and the provider-neutral core
// name the same providers and effort levels. A provider added to one and not
// the other would be configurable without an adapter, or the reverse.
describe('AI settings and core stay in lockstep', () => {
  it('lists the same providers', () => {
    expect([...AI_PROVIDER_IDS]).toEqual([...PROVIDER_IDS]);
    expect(listProviderEntries().map((p) => p.id)).toEqual([...AI_PROVIDER_IDS]);
  });

  it('lists the same effort levels', () => {
    expect([...AI_EFFORTS]).toEqual([...EFFORTS]);
  });
});
