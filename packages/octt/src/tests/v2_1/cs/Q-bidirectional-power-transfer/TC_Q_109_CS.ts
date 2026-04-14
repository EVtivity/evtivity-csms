// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_109_CS: CsTestCase = {
  id: 'TC_Q_109_CS',
  name: 'Central dynamic schedule control with setpoint - push',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE or the entire station.',
  purpose:
    'To verify if the Charging Station is able to support DynamicControl charging profiles with the CSMS pushing updates.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_110_CS: CsTestCase = {
  id: 'TC_Q_110_CS',
  name: 'Central V2X control with dynamic CSMS setpoint - pull',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE or the entire station.',
  purpose:
    'To verify if the Charging Station is able to support pulling DynamicControl charging profiles from the CSMS.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
