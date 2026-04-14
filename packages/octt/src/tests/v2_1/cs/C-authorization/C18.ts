// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_105_CS: Integrated Payment Terminal - CSMS rejects authorization
 * Skipped: requires an integrated payment terminal that the CSS does not support.
 */
export const TC_C_105_CS: CsTestCase = {
  id: 'TC_C_105_CS',
  name: 'Integrated Payment Terminal - CSMS rejects authorization',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Start/authorize a transaction from a payment terminal connected directly to the Charging Station.',
  purpose:
    'To verify that the Charging Station correctly handles payment terminal authorizations when the CSMS rejects.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_106_CS: Integrated Payment Terminal - Only Payment Terminal authorises
 * Skipped: requires an integrated payment terminal that the CSS does not support.
 */
export const TC_C_106_CS: CsTestCase = {
  id: 'TC_C_106_CS',
  name: 'Integrated Payment Terminal - Only Payment Terminal authorises',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Start/authorize a transaction from a payment terminal where only the terminal authorises.',
  purpose:
    'To verify that the Charging Station can authorize a transaction using only a payment terminal without CSMS authorization.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_107_CS: Integrated Payment Terminal - Payment Terminal and CSMS authorises
 * Skipped: requires an integrated payment terminal that the CSS does not support.
 */
export const TC_C_107_CS: CsTestCase = {
  id: 'TC_C_107_CS',
  name: 'Integrated Payment Terminal - Payment Terminal and CSMS authorises',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Start/authorize a transaction from a payment terminal with both terminal and CSMS authorization.',
  purpose:
    'To verify if the Charging Station is able to handle authorization using a locally connected payment terminal with CSMS validation.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_108_CS: Integrated Payment Terminal - VAT number validation
 * Skipped: requires an integrated payment terminal with VAT number input that the CSS does not support.
 */
export const TC_C_108_CS: CsTestCase = {
  id: 'TC_C_108_CS',
  name: 'Integrated Payment Terminal - VAT number validation',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'VAT number validation via payment terminal.',
  purpose: 'To verify that the Charging Station can let CSMS validate VAT numbers.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
