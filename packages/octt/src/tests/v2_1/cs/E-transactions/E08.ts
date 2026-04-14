// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

export const TC_E_44_CS: CsTestCase = {
  id: 'TC_E_44_CS',
  name: 'Offline Behaviour - Stop transaction during offline period',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station queues TransactionEvent messages to inform the CSMS that a transaction occurred during an offline period.',
  purpose:
    'To verify if the Charging Station is able to queue TransactionEvent messages when the transaction stopped while offline.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_E_45_CS: CsTestCase = {
  id: 'TC_E_45_CS',
  name: 'Offline Behaviour - Stop transaction during offline period - Same GroupId',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The Charging Station queues TransactionEvent messages to inform the CSMS that a transaction occurred during an offline period.',
  purpose:
    'To verify if the Charging Station is able to queue TransactionEvent messages when the transaction stopped while offline using same GroupId.',
  execute: async (_ctx) => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
