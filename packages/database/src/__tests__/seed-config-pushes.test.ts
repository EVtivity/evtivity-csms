// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { demoConfigPush } from '../seed-config-pushes.js';

describe('demo config template pushes', () => {
  it('seeds every push completed with an outcome for each station, never pending', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const push = demoConfigPush(['sta_a', 'sta_b', 'sta_c'], (items) => {
        const status = items[i % items.length]!;
        seen.add(status);
        return status;
      });
      expect(push.status).toBe('completed');
      expect(push.stations.map((s) => s.stationId)).toEqual(['sta_a', 'sta_b', 'sta_c']);
      for (const s of push.stations) {
        expect(['accepted', 'rejected', 'failed']).toContain(s.status);
        expect(s.errorInfo).toBe(s.status === 'failed' ? 'Station offline' : null);
      }
    }
    expect([...seen].sort()).toEqual(['accepted', 'failed', 'rejected']);
  });
});
