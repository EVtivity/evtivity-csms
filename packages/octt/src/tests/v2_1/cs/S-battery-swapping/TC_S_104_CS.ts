// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_S_104_CS: CsTestCase = {
  id: 'TC_S_104_CS',
  name: 'Battery Swap - Charging - Variables validation',
  module: 'S-battery-swapping',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging station is able to support battery swapping.',
  purpose:
    'To verify whether the Charging Station is able to be configured correctly for battery swapping variables.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
