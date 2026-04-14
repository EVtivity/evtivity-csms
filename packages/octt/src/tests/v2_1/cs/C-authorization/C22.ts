// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_119_CS: Settlement - is rejected or fails - Failed
 * Skipped: requires an integrated payment terminal and settlement infrastructure that the CSS does not support.
 */
export const TC_C_119_CS: CsTestCase = {
  id: 'TC_C_119_CS',
  name: 'Settlement - is rejected or fails - Failed',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Settlement at end of transaction where settlement fails (payment terminal connection failure).',
  purpose:
    'To verify the Charging Station handles a failed settlement at the end of a transaction.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_120_CS: Settlement - is rejected or fails - Rejected
 * Skipped: requires an integrated payment terminal and settlement infrastructure that the CSS does not support.
 */
export const TC_C_120_CS: CsTestCase = {
  id: 'TC_C_120_CS',
  name: 'Settlement - is rejected or fails - Rejected',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Settlement at end of transaction where settlement is rejected by the payment terminal.',
  purpose:
    'To verify the Charging Station handles a rejected settlement at the end of a transaction.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
