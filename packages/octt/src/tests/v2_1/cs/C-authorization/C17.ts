// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_103_CS: Authorization with prepaid card - success
 * Skipped: requires a physical prepaid card (ISO14443 or ISO15693) that the CSS does not support.
 */
export const TC_C_103_CS: CsTestCase = {
  id: 'TC_C_103_CS',
  name: 'Authorization with prepaid card - success',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case verifies if the CS communicates the transaction limits correctly with prepaid cards.',
  purpose:
    'To verify if the Charging Station correctly handles prepaid card authorization with transaction limits.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_104_CS: Authorization with prepaid card - no credit
 * Skipped: requires a physical prepaid card (ISO14443 or ISO15693) that the CSS does not support.
 */
export const TC_C_104_CS: CsTestCase = {
  id: 'TC_C_104_CS',
  name: 'Authorization with prepaid card - no credit',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'This test case verifies if the CS handles prepaid cards with no credit.',
  purpose: 'To verify that the Charging Station handles when a prepaid card has no credit.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
