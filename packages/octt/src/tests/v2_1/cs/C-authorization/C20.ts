// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_113_CS: Integrated Payment Terminal - Cancelation after start of transaction - stopped by EV driver
 * Skipped: requires an integrated payment terminal, settlement, and NotifySettlement that the CSS does not support.
 */
export const TC_C_113_CS: CsTestCase = {
  id: 'TC_C_113_CS',
  name: 'Integrated Payment Terminal - Cancelation after start of transaction - stopped by EV driver',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station supports cancellation of a payment terminal authorization after a transaction has started.',
  purpose:
    'To verify cancellation handling after a transaction has started and the EV driver stops or EVConnectionTimeout occurs.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
