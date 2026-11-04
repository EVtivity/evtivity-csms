// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { transformerStationIds } from '../lib/station-layout.js';

describe('transformerStationIds', () => {
  it('collects the stations of its panels, their sub-panels and its step-down panels', () => {
    const fed = transformerStationIds({
      transformers: [
        { id: 'tfm_a', fedFromPanelId: null },
        { id: 'tfm_b', fedFromPanelId: null },
        { id: 'tfm_sd', fedFromPanelId: 'pnl_swb_a' },
        { id: 'tfm_idle', fedFromPanelId: null },
      ],
      panels: [
        { id: 'pnl_swb_a', parentPanelId: null, transformerId: 'tfm_a' },
        { id: 'pnl_sub_a', parentPanelId: 'pnl_swb_a', transformerId: null },
        { id: 'pnl_lv', parentPanelId: null, transformerId: 'tfm_sd' },
        { id: 'pnl_swb_b', parentPanelId: null, transformerId: 'tfm_b' },
        { id: 'pnl_orphan', parentPanelId: null, transformerId: null },
      ],
      circuits: [
        { id: 'c_dc', panelId: 'pnl_swb_a' },
        { id: 'c_sub', panelId: 'pnl_sub_a' },
        { id: 'c_ac', panelId: 'pnl_lv' },
        { id: 'c_b', panelId: 'pnl_swb_b' },
        { id: 'c_orphan', panelId: 'pnl_orphan' },
      ],
      stations: [
        { id: 'sta_dc', circuitId: 'c_dc' },
        { id: 'sta_sub', circuitId: 'c_sub' },
        { id: 'sta_ac', circuitId: 'c_ac' },
        { id: 'sta_b', circuitId: 'c_b' },
        { id: 'sta_orphan', circuitId: 'c_orphan' },
        { id: 'sta_none', circuitId: null },
      ],
    });
    expect(fed.get('tfm_a')?.sort()).toEqual(['sta_ac', 'sta_dc', 'sta_sub']);
    expect(fed.get('tfm_sd')).toEqual(['sta_ac']);
    expect(fed.get('tfm_b')).toEqual(['sta_b']);
    // A transformer that feeds nothing has no entry.
    expect(fed.has('tfm_idle')).toBe(false);
  });

  it('stops at a panel loop instead of running forever', () => {
    const fed = transformerStationIds({
      transformers: [{ id: 'tfm_a', fedFromPanelId: null }],
      panels: [
        { id: 'p1', parentPanelId: 'p2', transformerId: 'tfm_a' },
        { id: 'p2', parentPanelId: 'p1', transformerId: null },
      ],
      circuits: [{ id: 'c', panelId: 'p2' }],
      stations: [{ id: 's', circuitId: 'c' }],
    });
    expect(fed.get('tfm_a')).toEqual(['s']);
  });
});
