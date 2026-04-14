// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/**
 * TC_I_02_CSMS: Show EV Driver Final Total Cost After Charging
 * Use case: I03 (I03.FR.02)
 * Scenario:
 *   1. EVConnectedPreSession with MeterValue (1000)
 *   2. Authorized
 *   3. EnergyTransferStarted
 *   4. StopAuthorized
 *   5. EVConnectedPostSession
 *   6. StatusNotification Available + NotifyEvent
 *   7. TransactionEvent Ended with final meter value (6000)
 * Validations:
 *   Step 2: AuthorizeResponse - idTokenInfo.status = Accepted
 *   Step 4: TransactionEventResponse - idTokenInfo.status = Accepted, totalCost optional
 *   Step 7: Optional CostUpdatedRequest
 */
export const TC_I_02_CSMS: TestCase = {
  id: 'TC_I_02_CSMS',
  name: 'Show EV Driver Final Total Cost After Charging',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'While a transaction is ongoing, the driver wants to know how much the running total cost is, updated at a regular interval.',
  purpose:
    'To verify if the CSMS is able to correctly send the total cost as described in the OCPP specification.',
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

    const txId = `OCTT-TX-${String(Date.now())}`;

    // Step 1: EVConnectedPreSession with MeterValue
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'CablePluggedIn',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: 1000,
              context: 'Transaction.Begin',
              measurand: 'Energy.Active.Import.Register',
            },
          ],
        },
      ],
    });

    // Step 2: Authorized
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const authStatus = (authRes['idTokenInfo'] as Record<string, unknown>)?.['status'] as string;
    steps.push({
      step: 1,
      description: 'AuthorizeResponse - idTokenInfo.status = Accepted',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${authStatus}`,
    });

    // Step 3: EnergyTransferStarted
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
    });

    // Step 4: StopAuthorized
    const stopAuthRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'StopAuthorized',
      seqNo: 2,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const stopIdTokenStatus = (stopAuthRes['idTokenInfo'] as Record<string, unknown>)?.[
      'status'
    ] as string;
    steps.push({
      step: 2,
      description: 'StopAuthorized TransactionEventResponse - idTokenInfo.status = Accepted',
      status: stopIdTokenStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${stopIdTokenStatus}`,
    });

    // Step 5: EVConnectedPostSession
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // Step 6: StatusNotification Available + NotifyEvent
    await ctx.client.sendCall('NotifyEvent', {
      generatedAt: new Date().toISOString(),
      seqNo: 0,
      tbc: false,
      eventData: [
        {
          eventId: 1,
          timestamp: new Date().toISOString(),
          trigger: 'Delta',
          eventNotificationType: 'HardWiredNotification',
          actualValue: 'Available',
          component: { name: 'Connector' },
          variable: { name: 'AvailabilityState' },
        },
      ],
    });

    // Step 7: TransactionEvent Ended with final meter value 6000
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVCommunicationLost',
      seqNo: 3,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'Idle',
        stoppedReason: 'EVDisconnected',
      },
      evse: { id: 1, connectorId: 1 },
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            { value: 6000, context: 'Transaction.End', measurand: 'Energy.Active.Import.Register' },
          ],
        },
      ],
    });

    steps.push({
      step: 3,
      description: 'TransactionEvent Ended with final meter value',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

    // Wait for optional CostUpdatedRequest from CSMS
    let receivedCostUpdated = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'CostUpdated') {
          receivedCostUpdated = true;
          return {};
        }
        return {};
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'CostUpdated', {
        stationId: ctx.stationId,
        totalCost: 1.25,
        transactionId: txId,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 4,
      description: 'Optional CostUpdatedRequest from CSMS',
      status: 'passed',
      expected: 'CostUpdatedRequest (optional)',
      actual: receivedCostUpdated ? 'CostUpdatedRequest received' : 'Not received (optional)',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
