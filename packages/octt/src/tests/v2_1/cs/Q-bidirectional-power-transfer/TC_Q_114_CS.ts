// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_114_CS: CsTestCase = {
  id: 'TC_Q_114_CS',
  name: 'External V2X control - External System - Dynamic external limits control',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'An External System controls the charge and discharge limits or setpoint of a charging station via a local connection.',
  purpose:
    'To verify if the Charging Station is able to combine V2X with external control signals using limits.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_115_CS: CsTestCase = {
  id: 'TC_Q_115_CS',
  name: 'External V2X control - External System - Dynamic setpoint control',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'An External System controls the charge and discharge setpoint of a charging station via a local connection.',
  purpose:
    'To verify if the Charging Station is able to combine V2X with external control signals using setpoints.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_116_CS: CsTestCase = {
  id: 'TC_Q_116_CS',
  name: 'External V2X control - External System - Scheduled external limits control',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'An External System controls the charge and discharge limits of a charging station via a scheduled profile.',
  purpose:
    'To verify if the Charging Station is able to combine V2X with external scheduled control signals.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
