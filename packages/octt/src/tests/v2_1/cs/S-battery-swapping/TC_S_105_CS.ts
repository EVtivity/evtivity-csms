// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_S_105_CS: CsTestCase = {
  id: 'TC_S_105_CS',
  name: 'Battery Swap - Charging - Battery Swap Charging',
  module: 'S-battery-swapping',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging station is able to support battery swapping.',
  purpose:
    'To verify whether the Charging Station communicates the status changes correctly to the CSMS during the battery swap charging process.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
