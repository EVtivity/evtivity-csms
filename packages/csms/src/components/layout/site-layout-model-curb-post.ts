// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The AC curb post of a curbside site: the generic AC pedestal on the sidewalk
// behind the curb, its one port's cable hook on the street side.

import { createAcPedestalKit } from './site-layout-model-ac-pedestal';
import type { ChargerKit } from './site-layout-model-charger-parts';

/**
 * A curb post serves one parallel stall, so it has one port (the generic
 * AC pedestal model, mounted at the curb as curbside installs
 * do); its body and cable management are the pedestal's.
 */
export function createCurbPostKit(cableDiameterM?: number): ChargerKit {
  return createAcPedestalKit(1, cableDiameterM);
}
