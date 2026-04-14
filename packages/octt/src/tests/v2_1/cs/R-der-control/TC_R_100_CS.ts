// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';
export const TC_R_100_CS: CsTestCase = {
  id: 'TC_R_100_CS',
  name: 'Starting a V2X session with DER control in EVSE - Persistent DERControls',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Setting some DER controls and reboot the charging station. After reboot, retrieving the configured DER controls to check persistence.',
  purpose: 'To check if the configured DER Controls are persistent.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_R_101_CS: CsTestCase = {
  id: 'TC_R_101_CS',
  name: 'Starting a V2X session with DER control in EVSE - Device model',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Retrieve custom report from CS to check if the CS reports the mandatory configuration variables for DCDERCtrlr.',
  purpose:
    'To check if the CS reports the mandatory configuration variables for component DCDERCtrlr.',
  execute: async () => {
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
