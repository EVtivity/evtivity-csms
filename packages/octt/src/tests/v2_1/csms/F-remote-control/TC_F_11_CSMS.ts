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
 * TC_F_11_CSMS: Trigger message - MeterValues - Specific EVSE
 *
 * Scenario:
 *   1. CSMS sends TriggerMessageRequest (MeterValues, specific EVSE)
 *   2. Test System responds Accepted
 *   3. Test System sends MeterValuesRequest
 *   4. CSMS responds with MeterValuesResponse
 */
export const TC_F_11_CSMS: TestCase = {
  id: 'TC_F_11_CSMS',
  name: 'Trigger message - MeterValues - Specific EVSE',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a MeterValuesRequest for a specific EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedTrigger = false;
    let requestedMessage = '';
    let evseId: number | undefined;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
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
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'MeterValues',
        evse: { id: 1 },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'requestedMessage is MeterValues',
      status: requestedMessage === 'MeterValues' ? 'passed' : 'failed',
      expected: 'requestedMessage = MeterValues',
      actual: `requestedMessage = ${requestedMessage}`,
    });

    steps.push({
      step: 3,
      description: 'evse.id is specified',
      status: evseId != null && evseId > 0 ? 'passed' : 'failed',
      expected: 'evse.id present',
      actual: `evse.id = ${String(evseId ?? 'undefined')}`,
    });

    // Send MeterValues in response to the trigger
    if (receivedTrigger) {
      const mvRes = await ctx.client.sendCall('MeterValues', {
        evseId: evseId ?? 1,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: 1234.5,
                context: 'Trigger',
                measurand: 'Energy.Active.Import.Register',
              },
            ],
          },
        ],
      });

      steps.push({
        step: 4,
        description: 'MeterValues sent and response received',
        status: 'passed',
        expected: 'MeterValuesResponse received',
        actual: `Response keys: ${Object.keys(mvRes).join(', ') || '(empty)'}`,
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
 * TC_F_12_CSMS: Trigger message - MeterValues - All EVSE
 *
 * Scenario:
 *   1. CSMS sends TriggerMessageRequest (MeterValues, no EVSE)
 *   2. Test System responds Accepted
 *   3. Test System sends MeterValuesRequest for each EVSE
 *   4. CSMS responds with MeterValuesResponse
 */
export const TC_F_12_CSMS: TestCase = {
  id: 'TC_F_12_CSMS',
  name: 'Trigger message - MeterValues - All EVSE',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a MeterValuesRequest for all EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedTrigger = false;
    let requestedMessage = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'MeterValues',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'requestedMessage is MeterValues',
      status: requestedMessage === 'MeterValues' ? 'passed' : 'failed',
      expected: 'requestedMessage = MeterValues',
      actual: `requestedMessage = ${requestedMessage}`,
    });

    if (receivedTrigger) {
      const mvRes = await ctx.client.sendCall('MeterValues', {
        evseId: 1,
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: 1234.5,
                context: 'Trigger',
                measurand: 'Energy.Active.Import.Register',
              },
            ],
          },
        ],
      });

      steps.push({
        step: 3,
        description: 'MeterValues sent and response received',
        status: 'passed',
        expected: 'MeterValuesResponse received',
        actual: `Response keys: ${Object.keys(mvRes).join(', ') || '(empty)'}`,
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
 * TC_F_13_CSMS: Trigger message - TransactionEvent - Specific EVSE
 *
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. CSMS sends TriggerMessageRequest (TransactionEvent, specific EVSE)
 *   2. Test System responds Accepted
 *   3. Test System sends TransactionEventRequest with triggerReason Trigger
 *   4. CSMS responds with TransactionEventResponse
 */
export const TC_F_13_CSMS: TestCase = {
  id: 'TC_F_13_CSMS',
  name: 'Trigger message - TransactionEvent - Specific EVSE',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a TransactionEventRequest for a specific EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    // Start a transaction first (EnergyTransferStarted state)
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

    let receivedTrigger = false;
    let requestedMessage = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'TransactionEvent',
        evse: { id: 1 },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest for TransactionEvent',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'requestedMessage is TransactionEvent',
      status: requestedMessage === 'TransactionEvent' ? 'passed' : 'failed',
      expected: 'requestedMessage = TransactionEvent',
      actual: `requestedMessage = ${requestedMessage}`,
    });

    if (receivedTrigger) {
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Updated',
        timestamp: new Date().toISOString(),
        triggerReason: 'Trigger',
        seqNo: 1,
        transactionInfo: { transactionId: txId, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: 1000,
                context: 'Trigger',
                measurand: 'Energy.Active.Import.Register',
              },
            ],
          },
        ],
      });

      steps.push({
        step: 3,
        description: 'TransactionEvent with triggerReason Trigger sent',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(txRes).join(', ')}`,
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
 * TC_F_14_CSMS: Trigger message - TransactionEvent - All EVSE
 */
export const TC_F_14_CSMS: TestCase = {
  id: 'TC_F_14_CSMS',
  name: 'Trigger message - TransactionEvent - All EVSE',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a TransactionEventRequest for all EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

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

    let receivedTrigger = false;
    let requestedMessage = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'TransactionEvent',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest for TransactionEvent',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'requestedMessage is TransactionEvent',
      status: requestedMessage === 'TransactionEvent' ? 'passed' : 'failed',
      expected: 'requestedMessage = TransactionEvent',
      actual: `requestedMessage = ${requestedMessage}`,
    });

    if (receivedTrigger) {
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Updated',
        timestamp: new Date().toISOString(),
        triggerReason: 'Trigger',
        seqNo: 1,
        transactionInfo: { transactionId: txId, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: 1000,
                context: 'Trigger',
                measurand: 'Energy.Active.Import.Register',
              },
            ],
          },
        ],
      });

      steps.push({
        step: 3,
        description: 'TransactionEvent with triggerReason Trigger sent',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(txRes).join(', ')}`,
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
 * TC_F_15_CSMS: Trigger message - LogStatusNotification - Idle
 */
export const TC_F_15_CSMS: TestCase = {
  id: 'TC_F_15_CSMS',
  name: 'Trigger message - LogStatusNotification - Idle',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a LogStatusNotificationRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedTrigger = false;
    let requestedMessage = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'LogStatusNotification',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'requestedMessage is LogStatusNotification',
      status: requestedMessage === 'LogStatusNotification' ? 'passed' : 'failed',
      expected: 'requestedMessage = LogStatusNotification',
      actual: `requestedMessage = ${requestedMessage}`,
    });

    if (receivedTrigger) {
      const logRes = await ctx.client.sendCall('LogStatusNotification', {
        status: 'Idle',
      });

      steps.push({
        step: 3,
        description: 'LogStatusNotification sent with status Idle',
        status: 'passed',
        expected: 'LogStatusNotificationResponse received',
        actual: `Response keys: ${Object.keys(logRes).join(', ') || '(empty)'}`,
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
 * TC_F_18_CSMS: Trigger message - FirmwareStatusNotification - Idle
 */
export const TC_F_18_CSMS: TestCase = {
  id: 'TC_F_18_CSMS',
  name: 'Trigger message - FirmwareStatusNotification - Idle',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a FirmwareStatusNotificationRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedTrigger = false;
    let requestedMessage = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'FirmwareStatusNotification',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'requestedMessage is FirmwareStatusNotification',
      status: requestedMessage === 'FirmwareStatusNotification' ? 'passed' : 'failed',
      expected: 'requestedMessage = FirmwareStatusNotification',
      actual: `requestedMessage = ${requestedMessage}`,
    });

    if (receivedTrigger) {
      const fwRes = await ctx.client.sendCall('FirmwareStatusNotification', {
        status: 'Idle',
      });

      steps.push({
        step: 3,
        description: 'FirmwareStatusNotification sent with status Idle',
        status: 'passed',
        expected: 'FirmwareStatusNotificationResponse received',
        actual: `Response keys: ${Object.keys(fwRes).join(', ') || '(empty)'}`,
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
 * TC_F_20_CSMS: Trigger message - Heartbeat
 */
export const TC_F_20_CSMS: TestCase = {
  id: 'TC_F_20_CSMS',
  name: 'Trigger message - Heartbeat',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a HeartbeatRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedTrigger = false;
    let requestedMessage = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'Heartbeat',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'requestedMessage is Heartbeat',
      status: requestedMessage === 'Heartbeat' ? 'passed' : 'failed',
      expected: 'requestedMessage = Heartbeat',
      actual: `requestedMessage = ${requestedMessage}`,
    });

    if (receivedTrigger) {
      const hbRes = await ctx.client.sendCall('Heartbeat', {});

      steps.push({
        step: 3,
        description: 'Heartbeat sent and response received',
        status: 'passed',
        expected: 'HeartbeatResponse received',
        actual: `Response keys: ${Object.keys(hbRes).join(', ')}`,
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
 * TC_F_23_CSMS: Trigger message - StatusNotification - Specific EVSE - Available
 */
export const TC_F_23_CSMS: TestCase = {
  id: 'TC_F_23_CSMS',
  name: 'Trigger message - StatusNotification - Specific EVSE - Available',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a StatusNotificationRequest for a specific EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedTrigger = false;
    let requestedMessage = '';
    let triggerEvseId: number | undefined;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          const evse = payload['evse'] as Record<string, unknown> | undefined;
          if (evse != null) {
            triggerEvseId = Number(evse['id'] ?? 0);
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'StatusNotification',
        evse: { id: 1 },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest for StatusNotification',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'requestedMessage is StatusNotification with evse.id',
      status:
        requestedMessage === 'StatusNotification' && triggerEvseId != null ? 'passed' : 'failed',
      expected: 'requestedMessage = StatusNotification, evse.id present',
      actual: `requestedMessage = ${requestedMessage}, evse.id = ${String(triggerEvseId ?? 'undefined')}`,
    });

    if (receivedTrigger) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: triggerEvseId ?? 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Available sent',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification sent with connectorStatus Available',
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
 * TC_F_24_CSMS: Trigger message - StatusNotification - Specific EVSE - Occupied
 */
export const TC_F_24_CSMS: TestCase = {
  id: 'TC_F_24_CSMS',
  name: 'Trigger message - StatusNotification - Specific EVSE - Occupied',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to trigger the Charging Station to send a StatusNotificationRequest for a specific EVSE when Occupied.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    // Step 1: Send StatusNotification Occupied first
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Occupied',
      evseId: 1,
      connectorId: 1,
    });

    steps.push({
      step: 1,
      description: 'StatusNotification Occupied sent',
      status: 'passed',
      expected: 'StatusNotificationResponse received',
      actual: 'StatusNotification Occupied sent',
    });

    let receivedTrigger = false;
    let requestedMessage = '';
    let triggerEvseId: number | undefined;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          const evse = payload['evse'] as Record<string, unknown> | undefined;
          if (evse != null) {
            triggerEvseId = Number(evse['id'] ?? 0);
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'StatusNotification',
        evse: { id: 1 },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 2,
      description: 'CSMS sends TriggerMessageRequest for StatusNotification',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 3,
      description: 'requestedMessage is StatusNotification with evse.id',
      status:
        requestedMessage === 'StatusNotification' && triggerEvseId != null ? 'passed' : 'failed',
      expected: 'requestedMessage = StatusNotification, evse.id present',
      actual: `requestedMessage = ${requestedMessage}, evse.id = ${String(triggerEvseId ?? 'undefined')}`,
    });

    if (receivedTrigger) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Occupied',
        evseId: triggerEvseId ?? 1,
        connectorId: 1,
      });

      steps.push({
        step: 4,
        description: 'StatusNotification Occupied sent in response to trigger',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Occupied sent',
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
 * TC_F_27_CSMS: Trigger message - NotImplemented
 */
export const TC_F_27_CSMS: TestCase = {
  id: 'TC_F_27_CSMS',
  name: 'Trigger message - NotImplemented',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that does not support the requested message type.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedTrigger = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          return { status: 'NotImplemented' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'CustomTrigger',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? 'TriggerMessageRequest received'
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'Test System responds with NotImplemented',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'NotImplemented response sent',
      actual: receivedTrigger ? 'NotImplemented response sent' : 'No trigger received to respond',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_F_100_CSMS: Trigger message - CustomTrigger
 */
export const TC_F_100_CSMS: TestCase = {
  id: 'TC_F_100_CSMS',
  name: 'Trigger message - CustomTrigger',
  module: 'F-remote-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS can request a Charging Station to send Charging Station-initiated messages using a CustomTrigger.',
  purpose: 'To verify if the CSMS is able to trigger messages using a CustomTrigger.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let receivedTrigger = false;
    let requestedMessage = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'TriggerMessage') {
          receivedTrigger = true;
          requestedMessage = String(payload['requestedMessage'] ?? '');
          return { status: 'NotImplemented' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'TriggerMessage', {
        stationId: ctx.stationId,
        requestedMessage: 'CustomTrigger',
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends TriggerMessageRequest with CustomTrigger',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'TriggerMessageRequest received',
      actual: receivedTrigger
        ? `TriggerMessageRequest received, requestedMessage = ${requestedMessage}`
        : 'No TriggerMessageRequest received',
    });

    steps.push({
      step: 2,
      description: 'Test System responds with NotImplemented',
      status: receivedTrigger ? 'passed' : 'failed',
      expected: 'NotImplemented response sent',
      actual: receivedTrigger ? 'NotImplemented response sent' : 'No trigger received to respond',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
