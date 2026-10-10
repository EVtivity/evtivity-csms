// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase, TestContext } from '../../../../types.js';
import { newTransactionId } from '../../../../csms-test-helpers.js';
import { defaultReply } from '../../../../default-replies.js';
import { waitFor, waitForOnline } from '../../../../security-test-helpers.js';
import { reportLocalCostSupport, tariffPrices } from '../../../../tariff-test-helpers.js';
import { OCTT_THRESHOLD_KWH } from '../../../../tariff-test-constants.js';

/** An energy register reading in Wh (Energy.Active.Import.Register). */
function register(wh: number, context: string): Record<string, unknown>[] {
  return [
    {
      timestamp: new Date().toISOString(),
      sampledValue: [
        {
          value: wh,
          context,
          measurand: 'Energy.Active.Import.Register',
          unitOfMeasure: { unit: 'Wh' },
        },
      ],
    },
  ];
}

// Helper: boot and start energy transfer
async function bootAndStartTransaction(ctx: TestContext) {
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
  const txId = newTransactionId('OCTT-TX');
  await ctx.client.sendCall('TransactionEvent', {
    eventType: 'Started',
    timestamp: new Date().toISOString(),
    triggerReason: 'Authorized',
    seqNo: 0,
    transactionInfo: { transactionId: txId, chargingState: 'Charging' },
    evse: { id: 1, connectorId: 1 },
    idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
  });
  return txId;
}

/**
 * TC_I_113_CSMS: Local Cost Calculation - Change transaction tariff - TariffMaxElements
 * Use case: I11
 * Scenario:
 *   1. EnergyTransferStarted, at a station that reports local cost
 *      calculation without conditions (TariffCostCtrlr)
 *   Manual Action (the CSMS's own): the session crosses the energy threshold
 *   of the OCTT pricing group's bulk tariff, so with split billing the CSMS
 *   switches the session's tariff and sends the station the new one
 *   2. CSMS sends ChangeTransactionTariffRequest
 *   3. Respond TooManyElements
 */
export const TC_I_113_CSMS: TestCase = {
  id: 'TC_I_113_CSMS',
  name: 'Local Cost Calculation - Change transaction tariff - TariffMaxElements',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'CSMS changes the tariff that is associated with a transaction. This may be needed when dealing with time-of-use tariffs.',
  purpose: 'To verify if the CSMS is able to process a response indicating TooManyElements.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

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
    const reported = await reportLocalCostSupport(ctx, false);
    steps.push({
      step: 1,
      description: 'Station reports local cost calculation without conditions (TariffCostCtrlr)',
      status: reported == null ? 'passed' : 'failed',
      expected: 'Enabled[Tariff] = true, ConditionsSupported[Tariff] = false stored',
      actual: reported ?? 'stored',
    });
    if (ctx.callApi != null) await waitForOnline(ctx);

    let receivedTxId = '';
    let receivedTariff: Record<string, unknown> | undefined;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeTransactionTariff') {
          receivedTxId = String(payload['transactionId'] ?? '');
          receivedTariff = payload['tariff'] as Record<string, unknown> | undefined;
          return { status: 'TooManyElements' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    const txId = newTransactionId('OCTT-TX');
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
      meterValue: register(0, 'Transaction.Begin'),
    });
    // Past the bulk tariff's threshold: the MeterValues projection switches
    // the tariff segment and sends the tariff that applies from now.
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'MeterValuePeriodic',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      meterValue: register(OCTT_THRESHOLD_KWH * 1000 + 1000, 'Sample.Periodic'),
    });
    const received = await waitFor(() => receivedTariff != null, 30_000);

    steps.push({
      step: 2,
      description: 'CSMS sends ChangeTransactionTariffRequest at the tariff boundary',
      status: received ? 'passed' : 'failed',
      expected: 'ChangeTransactionTariffRequest received',
      actual: received ? `Received, transactionId = ${receivedTxId}` : 'Not received',
    });

    steps.push({
      step: 3,
      description: 'transactionId must match the active transaction',
      status: receivedTxId === txId ? 'passed' : 'failed',
      expected: `transactionId = ${txId}`,
      actual: `transactionId = ${receivedTxId}`,
    });

    // ConditionsSupported is false: the bulk tariff alone, without conditions.
    const energy = tariffPrices(receivedTariff, 'energy');
    steps.push({
      step: 4,
      description: 'tariff is the bulk tariff without conditions (energy 0.20)',
      status:
        energy.length === 1 && energy[0]?.['priceKwh'] === 0.2 && energy[0]['conditions'] == null
          ? 'passed'
          : 'failed',
      expected: 'energy.prices = [{ priceKwh: 0.2 }]',
      actual: JSON.stringify(energy),
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_I_114_CSMS: Local Cost Calculation - Change transaction tariff - TariffConditionsSupported is false
 * Use case: I11
 * Scenario:
 *   1. EnergyTransferStarted
 *   2. CSMS sends ChangeTransactionTariffRequest
 *   3. Respond ConditionNotSupported
 */
export const TC_I_114_CSMS: TestCase = {
  id: 'TC_I_114_CSMS',
  name: 'Local Cost Calculation - Change transaction tariff - TariffConditionsSupported is false',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'CSMS changes the tariff that is associated with a transaction with conditions when conditions are not supported.',
  purpose: 'To verify if the CSMS is able to process a response indicating ConditionNotSupported.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const txId = await bootAndStartTransaction(ctx);

    let receivedChangeTariff = false;
    let receivedTxId = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeTransactionTariff') {
          receivedChangeTariff = true;
          receivedTxId = String(payload['transactionId'] ?? '');
          return { status: 'ConditionNotSupported' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeTransactionTariff', {
        stationId: ctx.stationId,
        transactionId: txId,
        tariff: {
          tariffId: 'octt-tariff-114',
          currency: 'USD',
          validFrom: new Date().toISOString(),
          energy: {
            prices: [
              {
                priceKwh: 0.25,
                conditions: { startTimeOfDay: '08:00', endTimeOfDay: '20:00' },
              },
            ],
          },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ChangeTransactionTariffRequest',
      status: receivedChangeTariff ? 'passed' : 'failed',
      expected: 'ChangeTransactionTariffRequest received',
      actual: receivedChangeTariff ? `Received, transactionId = ${receivedTxId}` : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'transactionId must match the active transaction',
      status: receivedTxId === txId ? 'passed' : 'failed',
      expected: `transactionId = ${txId}`,
      actual: `transactionId = ${receivedTxId}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_I_115_CSMS: Local Cost Calculation - Change transaction tariff - TariffConditionsSupported is true
 * Use case: I11
 * Scenario:
 *   1. EnergyTransferStarted
 *   2. CSMS sends ChangeTransactionTariffRequest with conditions
 *   3. Respond Accepted
 */
export const TC_I_115_CSMS: TestCase = {
  id: 'TC_I_115_CSMS',
  name: 'Local Cost Calculation - Change transaction tariff - TariffConditionsSupported is true',
  module: 'I-tariff-and-cost',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'CSMS changes the tariff that is associated with a transaction with conditions when conditions are supported.',
  purpose:
    'To verify if the CSMS is able to change the tariff of a transaction with a tariff with conditions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const txId = await bootAndStartTransaction(ctx);

    let receivedChangeTariff = false;
    let receivedTxId = '';
    let tariffPayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeTransactionTariff') {
          receivedChangeTariff = true;
          receivedTxId = String(payload['transactionId'] ?? '');
          tariffPayload = payload;
          return { status: 'Accepted' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeTransactionTariff', {
        stationId: ctx.stationId,
        transactionId: txId,
        tariff: {
          tariffId: 'octt-tariff-115',
          currency: 'USD',
          validFrom: new Date().toISOString(),
          energy: {
            prices: [
              {
                priceKwh: 0.25,
                conditions: { startTimeOfDay: '08:00', endTimeOfDay: '20:00' },
              },
            ],
          },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ChangeTransactionTariffRequest',
      status: receivedChangeTariff ? 'passed' : 'failed',
      expected: 'ChangeTransactionTariffRequest received',
      actual: receivedChangeTariff ? `Received, transactionId = ${receivedTxId}` : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'transactionId must match the active transaction',
      status: receivedTxId === txId ? 'passed' : 'failed',
      expected: `transactionId = ${txId}`,
      actual: `transactionId = ${receivedTxId}`,
    });

    const tariff = tariffPayload['tariff'] as Record<string, unknown> | undefined;
    const validFrom = tariff?.['validFrom'];
    steps.push({
      step: 3,
      description: 'tariff.validFrom must not be omitted',
      status: validFrom != null ? 'passed' : 'failed',
      expected: 'validFrom present',
      actual: validFrom != null ? `validFrom = ${String(validFrom)}` : 'validFrom omitted',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
