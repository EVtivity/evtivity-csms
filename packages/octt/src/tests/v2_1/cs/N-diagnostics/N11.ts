// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

export const TC_N_105_CS: CsTestCase = {
  id: 'TC_N_105_CS',
  name: 'Set Frequent Periodic Variable Monitoring - Periodic',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS requests frequent periodic monitoring of variables via event streams.',
  purpose:
    'To test that Charging Station supports configuring frequent periodic variable monitoring.',
  execute: async (_ctx) => {
    // Requires CSS to open periodic event streams after SetVariableMonitoring with periodicEventStream.
    // CSS does not implement periodic event stream lifecycle.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_N_106_CS: CsTestCase = {
  id: 'TC_N_106_CS',
  name: 'Set Frequent Periodic Variable Monitoring - CSMS rejects stream',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS rejects the OpenPeriodicEventStream; station falls back to NotifyEvent.',
  purpose:
    'To test that Charging Station falls back to NotifyEvent when periodic stream is rejected.',
  execute: async (_ctx) => {
    // Requires CSS to open periodic event streams and handle rejection fallback.
    // CSS does not implement periodic event stream lifecycle.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_N_108_CS: CsTestCase = {
  id: 'TC_N_108_CS',
  name: 'Close Periodic Event Streams',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging Station closes periodic event stream when the monitor is cleared.',
  purpose:
    'To test that Charging Station closes the periodic event stream when the monitor is cleared.',
  execute: async (_ctx) => {
    // Requires CSS to open and close periodic event streams.
    // CSS does not implement periodic event stream lifecycle.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_N_109_CS: CsTestCase = {
  id: 'TC_N_109_CS',
  name: 'Adjust Periodic Event Streams',
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'CSMS adjusts the transmission rate of a periodic event stream.',
  purpose: 'To test that Charging Station supports adjusting periodic event streams.',
  execute: async (_ctx) => {
    // Requires CSS to open periodic event streams and support adjustment.
    // CSS does not implement periodic event stream lifecycle.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};
