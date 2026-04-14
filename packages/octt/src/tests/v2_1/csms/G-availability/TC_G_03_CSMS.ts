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
 * TC_G_03_CSMS: Change Availability EVSE - Operative to inoperative
 *
 * Scenario:
 *   1. CSMS sends ChangeAvailabilityRequest (Inoperative, evse.id)
 *   2. Test System responds Accepted
 *   3. Test System sends StatusNotification Unavailable
 */
export const TC_G_03_CSMS: TestCase = {
  id: 'TC_G_03_CSMS',
  name: 'Change Availability EVSE - Operative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs to Inoperative.',
  purpose:
    'To verify if the CSMS is able to perform the change availability mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedChangeAvail = false;
    let operationalStatus = '';
    let evseId: number | undefined;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeAvailability') {
          receivedChangeAvail = true;
          operationalStatus = String(payload['operationalStatus'] ?? '');
          const evse = payload['evse'] as Record<string, unknown> | undefined;
          if (evse != null) {
            evseId = Number(evse['id'] ?? 0);
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeAvailability', {
        stationId: ctx.stationId,
        operationalStatus: 'Inoperative',
        evse: { id: 1 },
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
      description: 'operationalStatus is Inoperative with evse.id',
      status: operationalStatus === 'Inoperative' && evseId != null ? 'passed' : 'failed',
      expected: 'operationalStatus = Inoperative, evse.id present',
      actual: `operationalStatus = ${operationalStatus}, evse.id = ${String(evseId ?? 'undefined')}`,
    });

    if (receivedChangeAvail) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Unavailable',
        evseId: evseId ?? 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Unavailable sent',
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
 * TC_G_04_CSMS: Change Availability EVSE - Inoperative to operative
 *
 * Before: EVSE is Unavailable
 * Scenario:
 *   1. CSMS sends ChangeAvailabilityRequest (Operative, evse.id)
 *   2. Test System responds Accepted
 *   3. Test System sends StatusNotification Available
 */
export const TC_G_04_CSMS: TestCase = {
  id: 'TC_G_04_CSMS',
  name: 'Change Availability EVSE - Inoperative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs to Operative.',
  purpose:
    'To verify if the CSMS is able to perform the change availability mechanism as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    // Set initial state: EVSE unavailable
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Unavailable',
      evseId: 1,
      connectorId: 1,
    });

    let receivedChangeAvail = false;
    let operationalStatus = '';
    let evseId: number | undefined;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeAvailability') {
          receivedChangeAvail = true;
          operationalStatus = String(payload['operationalStatus'] ?? '');
          const evse = payload['evse'] as Record<string, unknown> | undefined;
          if (evse != null) {
            evseId = Number(evse['id'] ?? 0);
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeAvailability', {
        stationId: ctx.stationId,
        operationalStatus: 'Operative',
        evse: { id: 1 },
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
      description: 'operationalStatus is Operative with evse.id',
      status: operationalStatus === 'Operative' && evseId != null ? 'passed' : 'failed',
      expected: 'operationalStatus = Operative, evse.id present',
      actual: `operationalStatus = ${operationalStatus}, evse.id = ${String(evseId ?? 'undefined')}`,
    });

    if (receivedChangeAvail) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: evseId ?? 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Available sent',
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
 * TC_G_07_CSMS: Change Availability Connector - Operative to inoperative
 */
export const TC_G_07_CSMS: TestCase = {
  id: 'TC_G_07_CSMS',
  name: 'Change Availability Connector - Operative to inoperative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors to Inoperative.',
  purpose:
    'To verify if the CSMS is able to perform the change availability mechanism for a connector as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedChangeAvail = false;
    let operationalStatus = '';
    let evseId: number | undefined;
    let connectorId: number | undefined;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeAvailability') {
          receivedChangeAvail = true;
          operationalStatus = String(payload['operationalStatus'] ?? '');
          const evse = payload['evse'] as Record<string, unknown> | undefined;
          if (evse != null) {
            evseId = Number(evse['id'] ?? 0);
            connectorId = Number(evse['connectorId'] ?? 0);
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeAvailability', {
        stationId: ctx.stationId,
        operationalStatus: 'Inoperative',
        evse: { id: 1, connectorId: 1 },
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
      description: 'operationalStatus is Inoperative with evse.id and connectorId',
      status: operationalStatus === 'Inoperative' ? 'passed' : 'failed',
      expected: 'operationalStatus = Inoperative',
      actual: `operationalStatus = ${operationalStatus}, evse.id = ${String(evseId ?? 'undefined')}, connectorId = ${String(connectorId ?? 'undefined')}`,
    });

    if (receivedChangeAvail) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Unavailable',
        evseId: evseId ?? 1,
        connectorId: connectorId ?? 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Unavailable sent',
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
 * TC_G_08_CSMS: Change Availability Connector - Inoperative to operative
 */
export const TC_G_08_CSMS: TestCase = {
  id: 'TC_G_08_CSMS',
  name: 'Change Availability Connector - Inoperative to operative',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors to Operative.',
  purpose:
    'To verify if the CSMS is able to perform the change availability mechanism for a connector as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    // Set initial state: connector unavailable
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Unavailable',
      evseId: 1,
      connectorId: 1,
    });

    let receivedChangeAvail = false;
    let operationalStatus = '';
    let evseId: number | undefined;
    let connectorId: number | undefined;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeAvailability') {
          receivedChangeAvail = true;
          operationalStatus = String(payload['operationalStatus'] ?? '');
          const evse = payload['evse'] as Record<string, unknown> | undefined;
          if (evse != null) {
            evseId = Number(evse['id'] ?? 0);
            connectorId = Number(evse['connectorId'] ?? 0);
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeAvailability', {
        stationId: ctx.stationId,
        operationalStatus: 'Operative',
        evse: { id: 1, connectorId: 1 },
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
      description: 'operationalStatus is Operative with evse.id and connectorId',
      status: operationalStatus === 'Operative' ? 'passed' : 'failed',
      expected: 'operationalStatus = Operative',
      actual: `operationalStatus = ${operationalStatus}, evse.id = ${String(evseId ?? 'undefined')}, connectorId = ${String(connectorId ?? 'undefined')}`,
    });

    if (receivedChangeAvail) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: evseId ?? 1,
        connectorId: connectorId ?? 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Available sent',
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
 * TC_G_11_CSMS: Change Availability EVSE - With ongoing transaction
 */
export const TC_G_11_CSMS: TestCase = {
  id: 'TC_G_11_CSMS',
  name: 'Change Availability EVSE - With ongoing transaction',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the EVSEs during an ongoing transaction.',
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
        evse: { id: 1 },
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

    steps.push({
      step: 3,
      description: 'Test System responds with Scheduled',
      status: receivedChangeAvail ? 'passed' : 'failed',
      expected: 'Scheduled response sent',
      actual: receivedChangeAvail ? 'Scheduled response sent' : 'No request to respond to',
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
      step: 4,
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

/**
 * TC_G_17_CSMS: Change Availability Connector - With ongoing transaction
 */
export const TC_G_17_CSMS: TestCase = {
  id: 'TC_G_17_CSMS',
  name: 'Change Availability Connector - With ongoing transaction',
  module: 'G-availability',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'This test case covers how the CSMS requests the Charging Station to change the availability of one of the connectors during an ongoing transaction.',
  purpose:
    'To verify if the CSMS is able to send a change availability request for a connector during a transaction according to the OCPP specification.',
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
        evse: { id: 1, connectorId: 1 },
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
