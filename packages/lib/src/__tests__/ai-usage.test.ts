// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  AI_BUDGET_SCOPES,
  AI_INTERACTIVE_USAGE_SURFACES,
  AI_USAGE_SURFACES,
  aiUsageDtoSchema,
} from '../ai-usage.js';
import type { AiBudgetCheckInput, AiBudgetDecision } from '../ai-usage.js';

describe('TC-AI-DR-02 driver support usage contract', () => {
  it('holds driver_support as an interactive usage surface', () => {
    expect(AI_USAGE_SURFACES).toContain('driver_support');
    expect(AI_INTERACTIVE_USAGE_SURFACES).toContain('driver_support');
    for (const surface of AI_INTERACTIVE_USAGE_SURFACES)
      expect(AI_USAGE_SURFACES).toContain(surface);
  });

  it('holds the driver budget scope', () => {
    expect(AI_BUDGET_SCOPES).toContain('driver');
    const input: AiBudgetCheckInput = {
      surface: 'driver_support',
      driverId: 'drv_1',
      siteId: null,
    };
    const refusal: AiBudgetDecision = {
      allowed: false,
      code: 'AI_BUDGET_EXCEEDED',
      scope: 'driver',
      period: 'day',
      retryAfterSeconds: 60,
    };
    expect(input.driverId).toBe('drv_1');
    expect(refusal.allowed).toBe(false);
  });

  it('accepts driver_support in the usage DTO surface rows', () => {
    const totals = {
      tokens: { input: 1, cachedRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
      totalTokens: 2,
      costMicros: 0,
    };
    const dto = {
      month: '2026-10',
      period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' },
      company: null,
      unattributed: null,
      sites: [],
      surfaces: [{ surface: 'driver_support', totals }],
      topUsers: null,
    };
    expect(aiUsageDtoSchema.safeParse(dto).success).toBe(true);
  });
});
