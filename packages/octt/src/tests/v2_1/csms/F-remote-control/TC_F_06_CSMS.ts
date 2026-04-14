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
  await ctx.client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Available',
    evseId: 1,
    connectorId: 1,
  });
}

/**
 * TC_F_06_CSMS: Remote unlock Connector - Without ongoing transaction - Accepted
 *
 * Scenario:
 *   1. CSMS sends UnlockConnectorRequest
 *   2. Test System responds with Unlocked
 */
export const TC_F_06_CSMS: TestCase = {
  id: 'TC_F_06_CSMS',
  name: 'Remote unlock Connector - Without ongoing transaction - Accepted',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case describes how the CSMS can be requested to send an UnlockConnectorRequest to the Charging Station.',
  purpose:
    'To verify if the CSMS is able to perform the remote unlock connector mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedUnlock = false;
    let hasEvseId = false;
    let hasConnectorId = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'UnlockConnector') {
          receivedUnlock = true;
          if (payload['evseId'] != null) hasEvseId = true;
          if (payload['connectorId'] != null) hasConnectorId = true;
          return { status: 'Unlocked' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UnlockConnector', {
        stationId: ctx.stationId,
        evseId: 1,
        connectorId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UnlockConnectorRequest',
      status: receivedUnlock ? 'passed' : 'failed',
      expected: 'UnlockConnectorRequest received',
      actual: receivedUnlock
        ? 'UnlockConnectorRequest received'
        : 'No UnlockConnectorRequest received',
    });

    steps.push({
      step: 2,
      description: 'UnlockConnectorRequest contains evseId and connectorId',
      status: hasEvseId && hasConnectorId ? 'passed' : 'failed',
      expected: 'evseId and connectorId present',
      actual: `hasEvseId = ${String(hasEvseId)}, hasConnectorId = ${String(hasConnectorId)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
