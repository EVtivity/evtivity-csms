// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The root cause stored with a background worker suggestion: the worker's own
// when it has one, else the kind's fallback with a confidence that matches it.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@evtivity/database', () => ({ db: {}, client: {} }));
vi.mock('../ai-evidence/state.js', () => ({ currentFingerprints: vi.fn() }));

const { workerActionRootCause } = await import('../ai-insight.service.js');

describe('workerActionRootCause', () => {
  it('keeps the root cause the worker found', () => {
    expect(
      workerActionRootCause({
        kind: 'stuck_session',
        rootCause: { category: 'connectivity', confidence: 'high' },
      }),
    ).toEqual({ category: 'connectivity', confidence: 'high' });
  });

  it('uses the kind fallback with medium confidence for a known category', () => {
    expect(workerActionRootCause({ kind: 'station_long_faulted' })).toEqual({
      category: 'hardware',
      confidence: 'medium',
    });
  });

  it('gives an unknown fallback low confidence', () => {
    expect(workerActionRootCause({ kind: 'stuck_session' })).toEqual({
      category: 'unknown',
      confidence: 'low',
    });
  });
});
