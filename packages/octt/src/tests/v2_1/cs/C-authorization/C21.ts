// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_114_CS: Settlement at end of transaction - settled by CS, receipt by CS
 * Skipped: requires an integrated payment terminal and settlement infrastructure that the CSS does not support.
 */
export const TC_C_114_CS: CsTestCase = {
  id: 'TC_C_114_CS',
  name: 'Settlement at end of transaction - settled by CS, receipt by CS',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Settlement at end of transaction where the settlement and receipt are handled by the CS.',
  purpose: 'To verify settlement handling where both settlement and receipt are by the CS.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_115_CS: Settlement at end of transaction - settled by CSMS
 * Skipped: requires an integrated payment terminal and settlement infrastructure that the CSS does not support.
 */
export const TC_C_115_CS: CsTestCase = {
  id: 'TC_C_115_CS',
  name: 'Settlement at end of transaction - settled by CSMS',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Settlement at end of transaction where the settlement is handled by CSMS.',
  purpose:
    'To verify the Charging Station does not send NotifySettlementRequest when settlement is by CSMS.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_116_CS: Settlement at end of transaction - settled by CS, receipt by CSMS
 * Skipped: requires an integrated payment terminal and settlement infrastructure that the CSS does not support.
 */
export const TC_C_116_CS: CsTestCase = {
  id: 'TC_C_116_CS',
  name: 'Settlement at end of transaction - settled by CS, receipt by CSMS',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Settlement at end of transaction where settlement is by CS and receipt by CSMS.',
  purpose: 'To verify settlement by CS with receipt provided by CSMS via NotifySettlementResponse.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
