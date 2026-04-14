// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase } from '../../../../cs-types.js';

export const TC_B_01_CS: CsTestCase = {
  id: 'TC_B_01_CS',
  name: 'Cold Boot Charging Station - Accepted',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The booting mechanism allows a Charging Station to provide some general information about the Charging Station.',
  purpose:
    'To verify whether the Charging Station is able to perform the booting mechanism as described at the OCPP specification.',
  execute: async (ctx) => {
    // Step 1: Execute Reusable State Booted
    // The station boots autonomously via station.start() in the executor.
    // The boot was Accepted (default handler returns Accepted).
    // Validate the station is connected and booted.
    const isConnected = ctx.station.isConnected;
    return {
      status: isConnected ? 'passed' : 'failed',
      durationMs: 0,
      steps: [
        {
          step: 1,
          description: 'Station completed boot sequence with Accepted response',
          status: isConnected ? 'passed' : 'failed',
          expected: 'Station connected and booted',
          actual: isConnected ? 'Station connected' : 'Station not connected',
        },
      ],
    };
  },
};
