// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The CSMS routes the demo sites' electrical trees on their layouts in a unit
// test (site-layout-demo-links.test.ts). The CSMS cannot import this package,
// so it reads a JSON copy of the demo sites it draws; this test keeps the copy
// equal to the plan. Regenerate it with UPDATE_DEMO_LAYOUT_FIXTURE=1.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { showsLoadPanels } from '@evtivity/lib/site-layout';
import { LAYOUT_DEMO } from '../seed-demo-layout-plan.js';

const FIXTURE = fileURLToPath(
  new URL(
    '../../../csms/src/components/layout/__tests__/fixtures/demo-layout-sites.json',
    import.meta.url,
  ),
);

/** The demo sites whose panels and links the 3D layout draws, as plain JSON. */
function fixture(): unknown {
  const sites = LAYOUT_DEMO.sites
    .filter((s) => showsLoadPanels(s.settings))
    .map((s) => ({
      id: s.id,
      name: s.name,
      settings: s.settings,
      panels: s.panels.map((p) => ({
        id: p.id,
        parentPanelId: p.parentPanelId,
        name: p.name,
        breakerRatingAmps: p.breakerRatingAmps,
        maxContinuousKw: p.maxContinuousKw,
        circuits: p.circuits.map((c) => ({
          id: c.id,
          name: c.name,
          breakerRatingAmps: c.breakerRatingAmps,
          maxContinuousKw: c.maxContinuousKw,
        })),
      })),
      stations: s.stations.map((st) => ({
        id: st.id,
        kind: st.kind,
        col: st.col,
        row: st.row,
        circuitId: st.circuitId,
        free: st.free ?? null,
        evses: st.evses ?? (st.kind === 'dc' ? 2 : 1),
      })),
    }));
  return JSON.parse(JSON.stringify({ sites })) as unknown;
}

describe('demo layout fixture of the CSMS', () => {
  it('holds the demo sites the 3D layout draws panels for, as the plan has them', () => {
    if (process.env['UPDATE_DEMO_LAYOUT_FIXTURE'] === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(fixture(), null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(fixture());
  });
});
