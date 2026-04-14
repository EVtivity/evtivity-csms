// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_125_CS: CsTestCase = {
  id: 'TC_Q_125_CS',
  name: 'Idle operationMode - Idle with EvseSleep',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To request the EV to not perform any charging or discharging. Preconditioning of the vehicle is allowed.',
  purpose:
    'To verify if the Charging Station is able to stop charging in Idle and report evseSleep.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_126_CS: CsTestCase = {
  id: 'TC_Q_126_CS',
  name: 'Idle operationMode - Idle with EvseSleep unsupported',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To request the EV to not perform any charging or discharging.',
  purpose: 'To verify if the Charging Station reports evseSleep as false when not supported.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_127_CS: CsTestCase = {
  id: 'TC_Q_127_CS',
  name: 'Idle operationMode - Charging profile validations',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To request the EV to not perform any charging or discharging.',
  purpose:
    'To verify if the Charging Station rejects charging profiles with limit, dischargingLimit and setpoints in Idle mode.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
