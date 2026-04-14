// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/** TC_E_10_CSMS: Start transaction options - Authorized - Local */
export const TC_E_10_CSMS: TestCase = {
  id: 'TC_E_10_CSMS',
  name: 'Start transaction options - Authorized - Local',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a transaction when the EV and EVSE are connected and authorized.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Step 1: Authorize
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const authStatus = (authRes['idTokenInfo'] as Record<string, unknown>)?.['status'] as string;
    steps.push({
      step: 1,
      description: 'Send AuthorizeRequest, expect Accepted',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${authStatus}`,
    });

    // Step 2: TransactionEvent Started
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    steps.push({
      step: 2,
      description: 'Send TransactionEvent Started',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(txRes).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_26_CSMS: Disconnect cable on EV-side - Suspend transaction
 * Use case: E10 (E10.FR.01)
 * Before: State is EnergyTransferSuspended
 * Scenario:
 *   1. TransactionEvent Updated with triggerReason EVCommunicationLost, chargingState Idle
 *   2. CSMS responds with TransactionEventResponse
 *   3. StatusNotification Available + NotifyEvent AvailabilityState Available
 *   4. CSMS responds accordingly
 *   5. TransactionEvent Updated with triggerReason CablePluggedIn, chargingState EVConnected
 *   6. CSMS responds with TransactionEventResponse
 *   7. TransactionEvent Updated with triggerReason ChargingStateChanged, chargingState Charging
 *   8. CSMS responds with TransactionEventResponse
 */
export const TC_E_26_CSMS: TestCase = {
  id: 'TC_E_26_CSMS',
  name: 'Disconnect cable on EV-side - Suspend transaction',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station can behave in several different ways when the cable is disconnected at the EV side.',
  purpose:
    'To verify if the CSMS can handle a Charging Station that suspends the transaction when the EV and EVSE are disconnected on the EV side.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot
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

    // Start transaction (EnergyTransferStarted)
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

    // Move to SuspendedEV (EnergyTransferSuspended)
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'SuspendedEV' },
      evse: { id: 1, connectorId: 1 },
    });

    // Step 1: EVCommunicationLost, Idle (cable disconnected)
    const step1Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 2,
      transactionInfo: { transactionId: txId, chargingState: 'Idle' },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Updated - EVCommunicationLost Idle',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step1Res).join(', ')}`,
    });

    // Step 3: StatusNotification Available
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // NotifyEvent - connector AvailabilityState Available
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      eventData: [
        {
          eventId: 1,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          actualValue: 'Available',
          component: {
            name: 'Connector',
            evse: { id: 1, connectorId: 1 },
          },
          variable: { name: 'AvailabilityState' },
          eventNotificationType: 'HardWiredNotification',
        },
      ],
    });

    steps.push({
      step: 2,
      description: 'StatusNotification Available + NotifyEvent AvailabilityState',
      status: 'passed',
      expected: 'Responses received',
      actual: 'StatusNotification and NotifyEvent sent',
    });

    // Step 5: CablePluggedIn, EVConnected (cable reconnected)
    const step5Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'CablePluggedIn',
      seqNo: 3,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 3,
      description: 'TransactionEvent Updated - CablePluggedIn EVConnected',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step5Res).join(', ')}`,
    });

    // Step 7: ChargingStateChanged, Charging (resume)
    const step7Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 4,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 4,
      description: 'TransactionEvent Updated - ChargingStateChanged Charging (resumed)',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step7Res).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
