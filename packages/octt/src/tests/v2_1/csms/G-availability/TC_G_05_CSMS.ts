// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station and send StatusNotification
async function bootAndStatus(ctx: {
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
 * TC_G_05_CSMS: Change Availability Charging Station - Operative to inoperative
 *
 * Scenario:
 *   1. CSMS sends ChangeAvailabilityRequest (Inoperative, no evse)
 *   2. Test System responds Accepted
 *   3. Test System sends StatusNotification Unavailable for all connectors
 */
export const TC_G_05_CSMS: TestCase = {
  id: 'TC_G_05_CSMS',
  name: 'Change Availability Charging Station - Operative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case describes how the CSMS requests the Charging Station to change the availability from Operative to Inoperative.',
  purpose:
    'To verify if the CSMS is able to perform the change availability mechanism for the entire Charging Station as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedChangeAvail = false;
    let operationalStatus = '';
    let hasEvse = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeAvailability') {
          receivedChangeAvail = true;
          operationalStatus = String(payload['operationalStatus'] ?? '');
          if (payload['evse'] != null) hasEvse = true;
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeAvailability', {
        stationId: ctx.stationId,
        operationalStatus: 'Inoperative',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ChangeAvailabilityRequest',
      status: receivedChangeAvail ? 'passed' : 'failed',
      expected: 'ChangeAvailabilityRequest received',
      actual: receivedChangeAvail
        ? 'ChangeAvailabilityRequest received'
        : 'No ChangeAvailabilityRequest received',
    });

    steps.push({
      step: 2,
      description: 'operationalStatus is Inoperative',
      status: operationalStatus === 'Inoperative' ? 'passed' : 'failed',
      expected: 'operationalStatus = Inoperative',
      actual: `operationalStatus = ${operationalStatus}, hasEvse = ${String(hasEvse)}`,
    });

    if (receivedChangeAvail) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Unavailable',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Unavailable sent for all connectors',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Unavailable sent',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_G_06_CSMS: Change Availability Charging Station - Inoperative to operative
 *
 * Before: Charging Station set to Unavailable
 * Scenario:
 *   1. CSMS sends ChangeAvailabilityRequest (Operative, no evse)
 *   2. Test System responds Accepted
 *   3. Test System sends StatusNotification Available for all connectors
 */
export const TC_G_06_CSMS: TestCase = {
  id: 'TC_G_06_CSMS',
  name: 'Change Availability Charging Station - Inoperative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case describes how the CSMS requests the Charging Station to change the availability from Inoperative to Operative.',
  purpose:
    'To verify if the CSMS is able to perform the change availability mechanism for the entire Charging Station as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    // Set initial state: station unavailable
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Unavailable',
      evseId: 1,
      connectorId: 1,
    });

    let receivedChangeAvail = false;
    let operationalStatus = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeAvailability') {
          receivedChangeAvail = true;
          operationalStatus = String(payload['operationalStatus'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeAvailability', {
        stationId: ctx.stationId,
        operationalStatus: 'Operative',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ChangeAvailabilityRequest',
      status: receivedChangeAvail ? 'passed' : 'failed',
      expected: 'ChangeAvailabilityRequest received',
      actual: receivedChangeAvail
        ? 'ChangeAvailabilityRequest received'
        : 'No ChangeAvailabilityRequest received',
    });

    steps.push({
      step: 2,
      description: 'operationalStatus is Operative',
      status: operationalStatus === 'Operative' ? 'passed' : 'failed',
      expected: 'operationalStatus = Operative',
      actual: `operationalStatus = ${operationalStatus}`,
    });

    if (receivedChangeAvail) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Available sent for all connectors',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Available sent',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_G_14_CSMS: Change Availability Charging Station - With ongoing transaction
 */
export const TC_G_14_CSMS: TestCase = {
  id: 'TC_G_14_CSMS',
  name: 'Change Availability Charging Station - With ongoing transaction',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of the entire station during an ongoing transaction.',
  purpose:
    'To verify if the CSMS is able to send a change availability request during a transaction according to the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    // Start a transaction
    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    let receivedChangeAvail = false;
    let operationalStatus = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeAvailability') {
          receivedChangeAvail = true;
          operationalStatus = String(payload['operationalStatus'] ?? '');
          return { status: 'Scheduled' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeAvailability', {
        stationId: ctx.stationId,
        operationalStatus: 'Inoperative',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ChangeAvailabilityRequest during transaction',
      status: receivedChangeAvail ? 'passed' : 'failed',
      expected: 'ChangeAvailabilityRequest received',
      actual: receivedChangeAvail
        ? 'ChangeAvailabilityRequest received'
        : 'No ChangeAvailabilityRequest received',
    });

    steps.push({
      step: 2,
      description: 'operationalStatus is Inoperative',
      status: operationalStatus === 'Inoperative' ? 'passed' : 'failed',
      expected: 'operationalStatus = Inoperative',
      actual: `operationalStatus = ${operationalStatus}`,
    });

    // End transaction
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 1,
      transactionInfo: { transactionId: txId, stoppedReason: 'Local' },
      evse: { id: 1, connectorId: 1 },
    });

    // Send Unavailable after transaction ends
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Unavailable',
      evseId: 1,
      connectorId: 1,
    });

    steps.push({
      step: 3,
      description: 'StatusNotification Unavailable sent after transaction ends',
      status: 'passed',
      expected: 'StatusNotification Unavailable sent',
      actual: 'StatusNotification Unavailable sent',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
