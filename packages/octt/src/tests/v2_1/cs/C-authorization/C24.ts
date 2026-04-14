// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_123_CS: Ad hoc payment via stand-alone payment terminal - local cost calculation
 * Skipped: requires a stand-alone payment terminal/kiosk that the CSS does not support.
 */
export const TC_C_123_CS: CsTestCase = {
  id: 'TC_C_123_CS',
  name: 'Ad hoc payment via stand-alone payment terminal - local cost calculation',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station supports ad hoc payment via stand-alone payment terminal with local cost calculation.',
  purpose: 'To verify ad hoc payment via stand-alone payment terminal with local cost calculation.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_124_CS: Ad hoc payment via stand-alone payment terminal - central cost calculation
 * Skipped: requires a stand-alone payment terminal/kiosk that the CSS does not support.
 */
export const TC_C_124_CS: CsTestCase = {
  id: 'TC_C_124_CS',
  name: 'Ad hoc payment via stand-alone payment terminal - central cost calculation',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging Station supports ad hoc payment via stand-alone payment terminal with central cost calculation.',
  purpose:
    'To verify ad hoc payment via stand-alone payment terminal with central cost calculation.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
