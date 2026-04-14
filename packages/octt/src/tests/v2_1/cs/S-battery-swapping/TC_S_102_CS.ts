// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_S_102_CS: CsTestCase = {
  id: 'TC_S_102_CS',
  name: 'Battery Swap - Remote Start - not enough batteries',
  module: 'S-battery-swapping',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging station is able to support battery swapping.',
  purpose:
    'To verify whether the Charging Station is able to communicate when batteries are not available for a swap.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
