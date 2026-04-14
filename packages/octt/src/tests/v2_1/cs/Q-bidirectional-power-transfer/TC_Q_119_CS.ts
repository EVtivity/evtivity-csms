// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_119_CS: CsTestCase = {
  id: 'TC_Q_119_CS',
  name: 'Frequency Support - Local V2X control - Charging profile validations',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To allow an EV to be used for frequency control, depending on local frequency readings.',
  purpose:
    'To verify if the Charging Station is able to validate the charging profile for frequency support.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_120_CS: CsTestCase = {
  id: 'TC_Q_120_CS',
  name: 'Frequency Support - Local V2X control - AFRR support',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'To allow an EV to be used for frequency control, depending on local frequency readings.',
  purpose: 'To verify if the Charging Station validates AFRR signal requirements correctly.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
