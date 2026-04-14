// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

export const TC_E_43_CS: CsTestCase = {
  id: 'TC_E_43_CS',
  name: 'Offline Behaviour - Transaction during offline period',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station queues TransactionEvent messages to inform the CSMS that a transaction occurred during an offline period.',
  purpose:
    'To verify if the Charging Station is able to queue TransactionEvent messages while it was offline.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
