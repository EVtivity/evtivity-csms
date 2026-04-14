// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_111_CS: CsTestCase = {
  id: 'TC_Q_111_CS',
  name: 'External V2X control - with a charging profile from CSMS - setpoint',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS explicitly allows an External System to control the charge and discharge behaviour of an EV.',
  purpose:
    'To verify if the Charging Station is able to inform the CSMS when its capacity is being throttled by a locally connected external system.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_112_CS: CsTestCase = {
  id: 'TC_Q_112_CS',
  name: 'External V2X control - with a charging profile from CSMS - limit',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS explicitly allows an External System to control the charge and discharge behaviour of an EV.',
  purpose:
    'To verify if the Charging Station is able to inform the CSMS when its capacity is being throttled by a locally connected external system via limits.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_113_CS: CsTestCase = {
  id: 'TC_Q_113_CS',
  name: 'External V2X control - with a charging profile from CSMS - Duration expired',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'CSMS explicitly allows an External System to control the charge and discharge behaviour of an EV.',
  purpose:
    'To verify if the Charging Station correctly handles duration expiration on ExternalLimits profiles.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
