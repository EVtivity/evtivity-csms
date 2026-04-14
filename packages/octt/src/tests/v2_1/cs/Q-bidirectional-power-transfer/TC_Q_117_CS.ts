// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_117_CS: CsTestCase = {
  id: 'TC_Q_117_CS',
  name: 'Frequency Support - Central V2X control - push',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To allow an EV to be used for frequency support, with control at the CSMS.',
  purpose:
    'To verify if the Charging Station is able to support DynamicControl charging profiles with the CSMS pushing CentralFrequency updates.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_118_CS: CsTestCase = {
  id: 'TC_Q_118_CS',
  name: 'Frequency Support - Central V2X control - Duration expired',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To allow an EV to be used for frequency support, with control at the CSMS.',
  purpose:
    'To verify if the Charging Station handles duration expiration on CentralFrequency profiles.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
