// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Where a station's status marker floats: a small fixed gap above the top of
// its own charger model (owner decision 2026-11-02), not at one shared height.

import { SPLIT_SYSTEM } from '@evtivity/lib/site-layout';
import { AC_PEDESTAL } from './site-layout-model-ac-pedestal';
import { DC_DISPENSER } from './site-layout-model-dc-dispenser';
import { AC_WALL_BOX } from './site-layout-model-wall-box';

/** The gap between a charger model's top and its status marker. */
export const MARKER_GAP_M = 0.25;

/**
 * The wall box bottom above the sidewalk (the scene's mounting height,
 * `AC_WALL_BOX.bottomM`): 0.68 m, under 27 in (0.686 m), so the box (125 mm
 * deep, more than 4 in) meets the protrusion limit of the 2010 ADA Standards
 * 307.2 over the sidewalk (owner decision 2026-11-10), as the facade
 * panelboard does.
 */
export const WALL_BOX_BOTTOM_M = AC_WALL_BOX.bottomM;

/** The split satellite's foot under its body. */
const SATELLITE_FOOT_M = 0.1;

export type MarkerModel = 'dc' | 'ac' | 'wall' | 'satellite';

/** The top of each standard charger model, from its model constants. */
export function chargerModelTopM(model: MarkerModel): number {
  switch (model) {
    case 'dc':
      return DC_DISPENSER.heightM;
    case 'ac':
      return AC_PEDESTAL.head.topM;
    case 'wall':
      return WALL_BOX_BOTTOM_M + AC_WALL_BOX.heightM;
    case 'satellite':
      return SATELLITE_FOOT_M + SPLIT_SYSTEM.dispenser.heightM;
  }
}

/** The status marker height of a model whose top is `modelTopM`. */
export function markerY(modelTopM: number): number {
  return modelTopM + MARKER_GAP_M;
}
