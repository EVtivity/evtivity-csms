// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_Q_122_CS: CsTestCase = {
  id: 'TC_Q_122_CS',
  name: 'Local V2X control for load balancing - threshold validations',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To allow the EV to be utilized for locally controlled load balancing.',
  purpose:
    'To verify that the Charging Station for which LocalLoadBalancing has not correctly configured, rejects the profile.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_Q_123_CS: CsTestCase = {
  id: 'TC_Q_123_CS',
  name: 'Local V2X control for load balancing - not supported',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'To allow the EV to be utilized for locally controlled load balancing.',
  purpose:
    'To verify if the Charging Station responds correctly if it does not support Local Load Balancing.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
