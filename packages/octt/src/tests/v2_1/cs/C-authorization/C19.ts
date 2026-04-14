// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_109_CS: Integrated Payment Terminal - Cancelation prior to transaction - Only PT authorised - EVConnectTimeout
 * Skipped: requires an integrated payment terminal that the CSS does not support.
 */
export const TC_C_109_CS: CsTestCase = {
  id: 'TC_C_109_CS',
  name: 'Integrated Payment Terminal - Cancelation prior to transaction - Only PT authorised - EVConnectTimeout',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station supports cancellation of a payment terminal authorization when no EV is connected.',
  purpose:
    'To verify if the Charging Station handles cancellation of a payment terminal authorization when no EV is connected after EVConnectionTimeout.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_110_CS: Integrated Payment Terminal - Cancelation prior to transaction - PT and CSMS authorised
 * Skipped: requires an integrated payment terminal and NotifySettlement that the CSS does not support.
 */
export const TC_C_110_CS: CsTestCase = {
  id: 'TC_C_110_CS',
  name: 'Integrated Payment Terminal - Cancelation prior to transaction - PT and CSMS authorised',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station supports cancellation of a payment terminal authorization when EV driver cancels after CSMS auth.',
  purpose: 'To verify cancellation handling after both payment terminal and CSMS have authorized.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_111_CS: Integrated Payment Terminal - Cancelation prior to transaction - Only PT authorised - EV driver cancels
 * Skipped: requires an integrated payment terminal that the CSS does not support.
 */
export const TC_C_111_CS: CsTestCase = {
  id: 'TC_C_111_CS',
  name: 'Integrated Payment Terminal - Cancelation prior to transaction - Only PT authorised - EV driver cancels',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station supports cancellation when EV driver cancels after only PT authorization.',
  purpose:
    'To verify cancellation handling when only payment terminal authorized and EV driver cancels.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_112_CS: Integrated Payment Terminal - Cancelation prior to transaction - PT and CSMS authorised - EVConnectTimeout
 * Skipped: requires an integrated payment terminal and NotifySettlement that the CSS does not support.
 */
export const TC_C_112_CS: CsTestCase = {
  id: 'TC_C_112_CS',
  name: 'Integrated Payment Terminal - Cancelation prior to transaction - PT and CSMS authorised - EVConnectTimeout',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station supports cancellation of a payment terminal authorization when EVConnectionTimeout occurs after CSMS auth.',
  purpose:
    'To verify cancellation handling when EVConnectionTimeout occurs after both PT and CSMS auth.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
