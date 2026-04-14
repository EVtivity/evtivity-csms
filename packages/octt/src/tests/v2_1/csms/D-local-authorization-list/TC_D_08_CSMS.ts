// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station
async function boot(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
  await ctx.client.sendCall('BootNotification', {
    chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
    reason: 'PowerUp',
  });
}

/**
 * TC_D_08_CSMS: Get Local List Version - Success
 *
 * Scenario:
 *   1. CSMS sends GetLocalListVersionRequest
 *   2. Test System responds with versionNumber (configured)
 */
export const TC_D_08_CSMS: TestCase = {
  id: 'TC_D_08_CSMS',
  name: 'Get Local List Version - Success',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station for the version number of the Local Authorization List by sending a GetLocalListVersionRequest.',
  purpose:
    'To verify if the CSMS is able to request the Local Authorization List version according to the mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedGetVersion = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'GetLocalListVersion') {
          receivedGetVersion = true;
          return { versionNumber: 1 };
        }
        if (action === 'SendLocalList') {
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetLocalListVersion', {
        stationId: ctx.stationId,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetLocalListVersionRequest',
      status: receivedGetVersion ? 'passed' : 'failed',
      expected: 'GetLocalListVersionRequest received',
      actual: receivedGetVersion
        ? 'GetLocalListVersionRequest received'
        : 'No GetLocalListVersionRequest received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_D_09_CSMS: Get Local List Version - No list available
 *
 * Scenario:
 *   1. CSMS sends GetLocalListVersionRequest
 *   2. Test System responds with versionNumber 0
 */
export const TC_D_09_CSMS: TestCase = {
  id: 'TC_D_09_CSMS',
  name: 'Get Local List Version - No list available',
  module: 'D-local-authorization-list',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station for the version number of the Local Authorization List when no list is available.',
  purpose:
    'To verify if the CSMS is able to request the Local Authorization List version when no list is available according to the mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedGetVersion = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'GetLocalListVersion') {
          receivedGetVersion = true;
          return { versionNumber: 0 };
        }
        if (action === 'SendLocalList') {
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetLocalListVersion', {
        stationId: ctx.stationId,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetLocalListVersionRequest',
      status: receivedGetVersion ? 'passed' : 'failed',
      expected: 'GetLocalListVersionRequest received',
      actual: receivedGetVersion
        ? 'GetLocalListVersionRequest received'
        : 'No GetLocalListVersionRequest received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
