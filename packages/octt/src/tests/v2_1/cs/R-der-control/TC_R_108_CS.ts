// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_R_108_CS: CsTestCase = {
  id: 'TC_R_108_CS',
  name: 'Charging station reporting a DER event',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Configure a DER Control which will trigger and affect the charging rate of the running transaction, then verify alarms.',
  purpose: 'To check if the CS reports when DER controls are taking over.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
