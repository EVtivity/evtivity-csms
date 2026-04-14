// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot and start energy transfer
async function bootAndStartTransaction(ctx: {
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
  return txId;
}

/**
 * TC_I_113_CSMS: Local Cost Calculation - Change transaction tariff - TariffMaxElements
 * Use case: I11
 * Scenario:
 *   1. EnergyTransferStarted
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
    const txId = await bootAndStartTransaction(ctx);

    let receivedChangeTariff = false;
    let receivedTxId = '';

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ChangeTransactionTariff') {
          receivedChangeTariff = true;
          receivedTxId = String(payload['transactionId'] ?? '');
          return { status: 'TooManyElements' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ChangeTransactionTariff', {
        stationId: ctx.stationId,
        transactionId: txId,
        tariff: {
          tariffId: 'octt-tariff-113',
          currency: 'USD',
          validFrom: new Date().toISOString(),
          energy: { prices: [{ priceKwh: 0.3 }] },
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
        return {};
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
        return {};
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
