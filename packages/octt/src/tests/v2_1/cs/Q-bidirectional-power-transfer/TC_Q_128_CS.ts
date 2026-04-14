// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_128_CS: CsTestCase = {
  id: 'TC_Q_128_CS',
  name: 'Going offline during V2X operation - invalidAfterOfflineDuration = true',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To describe the amount of time that V2X operations may continue when the Charging Station is offline.',
  purpose:
    'To verify if the Charging station stops using the charging profile when Charging station is longer offline than maxOfflineDuration.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
