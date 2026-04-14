// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_102_CS: CsTestCase = {
  id: 'TC_Q_102_CS',
  name: 'V2X Authorisation - ISO15118-20 - Charging only (V2X control) before starting V2X - Allowed Energy',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Authorization of an EV by the CSMS to start a V2X power transfer loop.',
  purpose:
    'To verify if the Charging Station will enable charging only when CSMS does not provide an allowed energy transfer.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_107_CS: CsTestCase = {
  id: 'TC_Q_107_CS',
  name: 'V2X Authorisation - ISO15118-20 - Charging only (V2X control) before starting V2X',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To describe starting a transaction in ChargingOnly mode before getting approval to do V2X.',
  purpose: 'To verify if the Charging station uses Charging Only when CSMS does not allow V2X.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
