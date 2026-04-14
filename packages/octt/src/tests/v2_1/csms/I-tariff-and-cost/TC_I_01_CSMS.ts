// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station and send initial StatusNotification
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
 * TC_I_01_CSMS: Show EV Driver running total cost during charging - costUpdatedRequest
 * Use case: I02 (I02.FR.01)
 * Scenario:
 *   1. Authorize
 *   2. TransactionEvent Updated (Authorized)
 *   3-4. EVConnectedPreSession + EnergyTransferStarted
 *   5-6. TransactionEvent Updated (MeterValuePeriodic) x2
 *   7. CSMS sends CostUpdatedRequest
 *   8. Test System responds with CostUpdatedResponse
 */
export const TC_I_01_CSMS: TestCase = {
  id: 'TC_I_01_CSMS',
  name: 'Show EV Driver running total cost during charging - costUpdatedRequest',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'While a transaction is ongoing, the driver wants to know how much the running total cost is, updated at a regular interval.',
  purpose:
    'To verify if the CSMS is able to correctly send the running total cost as described in the OCPP specification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    // Step 1-2: Authorize
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const authStatus = (authRes['idTokenInfo'] as Record<string, unknown>)?.['status'] as string;
    steps.push({
      step: 1,
      description: 'Send AuthorizeRequest',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted',
      actual: `idTokenInfo.status = ${authStatus}`,
    });

    // Step 3-4: TransactionEvent Updated (Authorized)
    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    // EVConnected + EnergyTransferStarted
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'CablePluggedIn',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
    });

    // Step 5-6: Send MeterValuePeriodic updates
    for (let i = 0; i < 2; i++) {
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Updated',
        timestamp: new Date().toISOString(),
        triggerReason: 'MeterValuePeriodic',
        seqNo: i + 2,
        transactionInfo: { transactionId: txId, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: (i + 1) * 1000,
                context: 'Sample.Periodic',
                measurand: 'Energy.Active.Import.Register',
              },
            ],
          },
        ],
      });

      const totalCost = txRes['totalCost'];
      steps.push({
        step: i + 2,
        description: `TransactionEvent Updated - MeterValuePeriodic #${String(i + 1)}`,
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: totalCost != null ? `totalCost = ${String(totalCost)}` : 'totalCost omitted',
      });
    }

    // Step 7-8: Wait for CostUpdatedRequest from CSMS
    let receivedCostUpdated = false;
    let costValue: unknown = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'CostUpdated') {
          receivedCostUpdated = true;
          costValue = payload['totalCost'];
          return {};
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'CostUpdated', {
        stationId: ctx.stationId,
        totalCost: 1.5,
        transactionId: txId,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 4,
      description: 'CSMS sends CostUpdatedRequest',
      status: receivedCostUpdated ? 'passed' : 'failed',
      expected: 'CostUpdatedRequest received',
      actual: receivedCostUpdated
        ? `CostUpdated received, totalCost = ${String(costValue)}`
        : 'No CostUpdatedRequest received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
