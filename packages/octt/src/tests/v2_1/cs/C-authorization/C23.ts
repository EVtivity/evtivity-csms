// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

/**
 * TC_C_121_CS: Incremental authorization - increasing enabled
 * Skipped: requires an integrated payment terminal with incremental authorization that the CSS does not support.
 */
export const TC_C_121_CS: CsTestCase = {
  id: 'TC_C_121_CS',
  name: 'Incremental authorization - increasing enabled',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging Station supports incremental authorization with increasing enabled.',
  purpose:
    'To verify if the Charging Station handles incremental authorization with increasing enabled.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

/**
 * TC_C_122_CS: Incremental authorization - increasing disabled
 * Skipped: requires an integrated payment terminal with incremental authorization that the CSS does not support.
 */
export const TC_C_122_CS: CsTestCase = {
  id: 'TC_C_122_CS',
  name: 'Incremental authorization - increasing disabled',
  module: 'C-authorization',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging Station supports incremental authorization with increasing disabled.',
  purpose:
    'To verify if the Charging Station handles incremental authorization with increasing disabled and stops when limit is reached.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
