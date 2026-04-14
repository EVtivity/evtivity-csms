// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_100_CS: CsTestCase = {
  id: 'TC_Q_100_CS',
  name: 'V2X Authorisation - V2X Tx Measurands defined',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorization of an EV by the CSMS to start a V2X power transfer loop.',
  purpose: 'To verify if the Charging Station is able to send the configured V2X measurands.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_101_CS: CsTestCase = {
  id: 'TC_Q_101_CS',
  name: 'V2X Authorisation - ISO15118-20 - Processing charging needs',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorization of an EV by the CSMS to start a V2X power transfer loop.',
  purpose: 'To verify if the Charging Station is able to provide bidirectional charging needs.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_103_CS: CsTestCase = {
  id: 'TC_Q_103_CS',
  name: 'V2X Authorisation - ISO15118-20 - Charging needs rejected',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorization of an EV by the CSMS to start a V2X power transfer loop.',
  purpose:
    'To verify if the Charging Station is able to end the transaction when the charging needs are rejected.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_104_CS: CsTestCase = {
  id: 'TC_Q_104_CS',
  name: 'V2X Authorisation - ISO15118-20 - Scheduled Control',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorization of an EV by the CSMS to start a V2X power transfer loop.',
  purpose: 'To verify if the Charging Station is able to support ISO15118-20 Schedule Control.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_130_CS: CsTestCase = {
  id: 'TC_Q_130_CS',
  name: 'V2X Authorisation - ISO15118-20 - has ISO15118ServiceRenegotiationSupport - Charging needs rejected',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorization of an EV by the CSMS to start a V2X power transfer loop.',
  purpose:
    'To verify if the Charging Station is able to end the transaction when the charging needs are rejected and renegotiate.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
