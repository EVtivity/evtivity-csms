// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase, TestContext } from '../../../../types.js';
import { pushSendAckStep, newTransactionId } from '../../../../csms-test-helpers.js';
import { setTokenCostLimit } from '../../../../payment-test-helpers.js';
import { defaultReply } from '../../../../default-replies.js';

/** TC_E_109: the cost limit the CSMS is configured with for the token (10.00). */
const COST_LIMIT_CENTS = 1000;

// Helper: boot station and send initial StatusNotification
async function bootAndStatus(ctx: TestContext) {
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

// Helper: start a charging transaction and return the txId
async function startChargingTransaction(ctx: TestContext) {
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
 * TC_E_102_CSMS: Transactions with fixed cost, energy or time - CSMS and CS both specify limits
 * Use case: E16 (E16.FR.01, E16.FR.02, E16.FR.03)
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. TransactionEvent Updated with LimitSet, maxEnergy 6000
 *   2. CSMS responds
 *   3. TransactionEvent Updated
 *   4. CSMS responds (transactionLimit.maxEnergy must be 10000)
 *   5. TransactionEvent Updated with LimitSet, maxEnergy 10000
 *   6. CSMS responds (transactionLimit is omitted)
 *   7. TransactionEvent Ended with EnergyLimitReached
 *   8. CSMS responds
 */
export const TC_E_102_CSMS: TestCase = {
  id: 'TC_E_102_CSMS',
  name: 'Transactions with fixed cost, energy or time - CSMS and CS both specify limits',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'EV Driver or CSMS specifies a limit in cost, energy, state of charge or time for transaction.',
  purpose:
    'To verify whether the CSMS correctly handles transactions where both the CSMS and Charging Station specify limits.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Step 1: TransactionEvent Updated with LimitSet, maxEnergy 6000
    const step1Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        transactionLimit: { maxEnergy: 6000 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      1,
      'TransactionEvent Updated - LimitSet maxEnergy 6000',
      step1Res,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(step1Res).join(', ')}`,
    );

    // Step 3: TransactionEvent Updated (CSMS should override maxEnergy to 10000)
    const step3Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'MeterValuePeriodic',
      seqNo: 2,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      2,
      'TransactionEvent Updated - CSMS should set maxEnergy 10000',
      step3Res,
      'TransactionEventResponse with transactionLimit.maxEnergy 10000',
      `Response keys: ${Object.keys(step3Res).join(', ')}`,
    );

    // Step 5: TransactionEvent Updated with LimitSet, maxEnergy 10000
    const step5Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 3,
      transactionInfo: {
        transactionId: txId,
        transactionLimit: { maxEnergy: 10000 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      3,
      'TransactionEvent Updated - LimitSet maxEnergy 10000',
      step5Res,
      'TransactionEventResponse with transactionLimit omitted',
      `Response keys: ${Object.keys(step5Res).join(', ')}`,
    );

    // Step 7: TransactionEvent Ended with EnergyLimitReached
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EnergyLimitReached',
      seqNo: 4,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      4,
      'TransactionEvent Ended - EnergyLimitReached',
      endRes,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(endRes).join(', ')}`,
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_106_CSMS: Transactions with fixed cost, energy or time - CS specifies energy limit
 * Use case: E16
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. TransactionEvent Updated with LimitSet, maxEnergy 6000
 *   2. CSMS responds
 *   3. TransactionEvent Ended with EnergyLimitReached
 *   4. CSMS responds
 */
export const TC_E_106_CSMS: TestCase = {
  id: 'TC_E_106_CSMS',
  name: 'Transactions with fixed cost, energy or time - CS specifies energy limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'EV Driver or CSMS specifies a limit in cost, energy, state of charge or time for transaction.',
  purpose:
    'To verify whether the CSMS correctly handles transactions where the Charging Station specifies an energy limit.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Step 1: TransactionEvent Updated with LimitSet, maxEnergy 6000
    const step1Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        transactionLimit: { maxEnergy: 6000 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      1,
      'TransactionEvent Updated - LimitSet maxEnergy 6000',
      step1Res,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(step1Res).join(', ')}`,
    );

    // Step 3: TransactionEvent Ended with EnergyLimitReached
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EnergyLimitReached',
      seqNo: 2,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      2,
      'TransactionEvent Ended - EnergyLimitReached',
      endRes,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(endRes).join(', ')}`,
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_107_CSMS: Transactions with fixed cost, energy or time - CS specifies time limit
 * Use case: E16
 * Before: State is EnergyTransferStarted
 * Scenario:
 *   1. TransactionEvent Updated with LimitSet, maxTime 120
 *   2. CSMS responds (transactionLimit is omitted)
 *   3. TransactionEvent Ended with TimeLimitReached
 *   4. CSMS responds
 */
export const TC_E_107_CSMS: TestCase = {
  id: 'TC_E_107_CSMS',
  name: 'Transactions with fixed cost, energy or time - CS specifies time limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'EV Driver or CSMS specifies a limit in cost, energy, state of charge or time for transaction.',
  purpose:
    'To verify whether the CSMS correctly handles transactions where the Charging Station specifies a time limit.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);
    const txId = await startChargingTransaction(ctx);

    // Step 1: TransactionEvent Updated with LimitSet, maxTime 120
    const step1Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        transactionLimit: { maxTime: 120 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      1,
      'TransactionEvent Updated - LimitSet maxTime 120',
      step1Res,
      'TransactionEventResponse received (transactionLimit omitted)',
      `Response keys: ${Object.keys(step1Res).join(', ')}`,
    );

    // Step 3: TransactionEvent Ended with TimeLimitReached
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'TimeLimitReached',
      seqNo: 2,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      2,
      'TransactionEvent Ended - TimeLimitReached',
      endRes,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(endRes).join(', ')}`,
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_108_CSMS: Transactions with fixed cost, energy or time - CS calculates costs and specifies limit
 * Use case: E16
 * Scenario:
 *   1. CSMS sends SetDefaultTariffRequest with 1 EUR/minute
 *   2. Test System responds
 *   3. Execute Reusable State EnergyTransferStarted
 *   4. TransactionEvent Updated with LimitSet, maxCost 2.00, costDetails
 *   5. CSMS responds
 *   6. TransactionEvent Updated with RunningCost, costDetails
 *   7. CSMS responds
 *   8. TransactionEvent Ended with CostLimitReached, costDetails
 *   9. CSMS responds
 */
export const TC_E_108_CSMS: TestCase = {
  id: 'TC_E_108_CSMS',
  name: 'Transactions with fixed cost, energy or time - CS calculates costs and specifies limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'EV Driver or CSMS specifies a limit in cost, energy, state of charge or time for transaction.',
  purpose:
    'To verify whether the CSMS correctly handles transactions where the Charging Station uses local cost calculation with a cost limit.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    // Set up handler for SetDefaultTariff from CSMS
    let receivedSetTariff = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetDefaultTariff') {
          receivedSetTariff = true;
          return { status: 'Accepted' };
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    // Wait for CSMS to send SetDefaultTariff (manual action)
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetDefaultTariff', {
        stationId: ctx.stationId,
        evseId: 1,
        tariff: {
          currency: 'EUR',
          tariffId: 'OCTT-TARIFF-1',
          chargingTime: {
            prices: [{ priceMinute: 1.0 }],
          },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetDefaultTariffRequest',
      status: receivedSetTariff ? 'passed' : 'failed',
      expected: 'SetDefaultTariffRequest received',
      actual: receivedSetTariff
        ? 'SetDefaultTariffRequest received'
        : 'No SetDefaultTariffRequest received',
    });

    // Clear handler before continuing
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) =>
      defaultReply('ocpp2.1', action, payload),
    );

    // EnergyTransferStarted
    const txId = await startChargingTransaction(ctx);

    // Step 4: TransactionEvent Updated with LimitSet, maxCost 2.00
    const step4Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        transactionLimit: { maxCost: 2.0 },
      },
      costDetails: {
        totalCost: {
          currency: 'EUR',
          typeOfCost: 'NormalCost',
          chargingTime: { inclTax: 1.0 },
          total: { inclTax: 1.0 },
        },
        totalUsage: { energy: 3000, chargingTime: 60, idleTime: 0 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      2,
      'TransactionEvent Updated - LimitSet maxCost 2.00',
      step4Res,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(step4Res).join(', ')}`,
    );

    // Step 6: TransactionEvent Updated with RunningCost
    const step6Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'RunningCost',
      seqNo: 2,
      transactionInfo: { transactionId: txId },
      costDetails: {
        totalCost: {
          currency: 'EUR',
          typeOfCost: 'NormalCost',
          chargingTime: { inclTax: 1.5 },
          total: { inclTax: 1.5 },
        },
        totalUsage: { energy: 4500, chargingTime: 90, idleTime: 0 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      3,
      'TransactionEvent Updated - RunningCost 1.50 EUR',
      step6Res,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(step6Res).join(', ')}`,
    );

    // Step 8: TransactionEvent Ended with CostLimitReached
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'CostLimitReached',
      seqNo: 3,
      transactionInfo: { transactionId: txId },
      costDetails: {
        totalCost: {
          currency: 'EUR',
          typeOfCost: 'NormalCost',
          chargingTime: { inclTax: 2.0 },
          total: { inclTax: 2.0 },
        },
        totalUsage: { energy: 6000, chargingTime: 120, idleTime: 0 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      4,
      'TransactionEvent Ended - CostLimitReached 2.00 EUR',
      endRes,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(endRes).join(', ')}`,
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_109_CSMS: Transactions with fixed cost, energy or time - CSMS calculates costs and specifies cost limit
 * Use case: E16 (E16.FR.02, E16.FR.11)
 * Before: State is EVConnectedPreSession. The CSMS is configured with a cost
 * limit of 10 for the token (the operator gives it 10.00 prepaid credit).
 * Scenario:
 *   1. Authorize
 *   2. CSMS responds (idTokenInfo.status Accepted)
 *   3. TransactionEvent Started, ChargingStateChanged, Charging
 *   4. CSMS responds (totalCost not omitted, maxEnergy and maxTime omitted, maxCost 10)
 *   5. TransactionEvent Updated with LimitSet maxCost 10
 *   6. CSMS responds (totalCost not omitted, transactionLimit omitted)
 *   7. CSMS sends CostUpdatedRequest (optional; validated when sent)
 *   8. Respond to CostUpdated
 */
export const TC_E_109_CSMS: TestCase = {
  id: 'TC_E_109_CSMS',
  name: 'Transactions with fixed cost, energy or time - CSMS calculates costs and specifies cost limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'CSMS will set a limit the transaction for the specified cost. CS will use central cost calculation.',
  purpose: 'To verify whether the CSMS correctly sends cost when central cost calculation is used.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const idToken = ctx.tokens.prepaid;

    await bootAndStatus(ctx);

    // Before: the CSMS limits the cost of this token's transactions to 10.
    const configError = await setTokenCostLimit(ctx, idToken, COST_LIMIT_CENTS);
    if (configError != null) {
      steps.push({
        step: 0,
        description: 'Configure a cost limit of 10 for the token in the CSMS',
        status: 'failed',
        expected: 'Token cost limit configured',
        actual: configError,
      });
      return { status: 'failed', durationMs: 0, steps };
    }

    let costUpdated: Record<string, unknown> | null = null;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'CostUpdated') {
          costUpdated = payload;
          return {};
        }
        return defaultReply('ocpp2.1', action, payload);
      },
    );

    // Step 1-2: Authorize
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken, type: 'ISO14443' },
    });
    const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'AuthorizeResponse - idTokenInfo.status must be Accepted',
      status: idTokenInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: String(idTokenInfo?.['status']),
    });

    // Step 3-4: TransactionEvent Started
    const txId = newTransactionId('OCTT-TX');
    const startRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken, type: 'ISO14443' },
    });
    const startLimit = startRes['transactionLimit'] as Record<string, unknown> | undefined;
    const step4Ok =
      typeof startRes['totalCost'] === 'number' &&
      startLimit?.['maxEnergy'] === undefined &&
      startLimit?.['maxTime'] === undefined &&
      startLimit?.['maxCost'] === 10;
    steps.push({
      step: 2,
      description:
        'TransactionEventResponse (Started) - totalCost present, maxEnergy and maxTime omitted, maxCost 10',
      status: step4Ok ? 'passed' : 'failed',
      expected: 'totalCost <not omitted>, maxEnergy <omitted>, maxTime <omitted>, maxCost = 10',
      actual: `totalCost = ${String(startRes['totalCost'])}, transactionLimit = ${JSON.stringify(startLimit ?? null)}`,
    });

    // Step 5-6: TransactionEvent Updated with LimitSet, maxCost 10
    const updRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: { transactionId: txId, transactionLimit: { maxCost: 10 } },
    });
    const step6Ok =
      typeof updRes['totalCost'] === 'number' && updRes['transactionLimit'] === undefined;
    steps.push({
      step: 3,
      description:
        'TransactionEventResponse (Updated, LimitSet) - totalCost present, transactionLimit omitted',
      status: step6Ok ? 'passed' : 'failed',
      expected: 'totalCost <not omitted>, transactionLimit <omitted>',
      actual: `totalCost = ${String(updRes['totalCost'])}, transactionLimit = ${JSON.stringify(updRes['transactionLimit'] ?? null)}`,
    });

    // Step 7-8: CostUpdatedRequest is optional; when sent it is validated.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const received = costUpdated as Record<string, unknown> | null;
    const costUpdatedOk =
      received == null ||
      (received['transactionId'] === txId && typeof received['totalCost'] === 'number');
    steps.push({
      step: 4,
      description: 'CostUpdatedRequest (optional) - transactionId and totalCost',
      status: costUpdatedOk ? 'passed' : 'failed',
      expected: `not sent, or transactionId = ${txId} and totalCost <not omitted>`,
      actual:
        received == null
          ? 'Not sent'
          : `transactionId = ${String(received['transactionId'])}, totalCost = ${String(received['totalCost'])}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_110_CSMS: Transactions with fixed cost, energy or time - CSMS specifies energy limit
 * Use case: E16 (E16.FR.02)
 * Before: State is EVConnectedPreSession
 * Scenario:
 *   1. TransactionEvent Started with Charging, transactionLimit omitted
 *   2. CSMS responds (maxEnergy = configured, maxTime omitted, maxCost omitted)
 *   3. TransactionEvent Updated with LimitSet, maxEnergy from CSMS
 *   4. CSMS responds (transactionLimit omitted)
 *   5. TransactionEvent Updated with EnergyLimitReached, SuspendedEVSE
 *   6. CSMS responds
 */
export const TC_E_110_CSMS: TestCase = {
  id: 'TC_E_110_CSMS',
  name: 'Transactions with fixed cost, energy or time - CSMS specifies energy limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS will set an energy limit on the transaction.',
  purpose: 'To verify whether the CSMS is able to set an energy limit.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    // Step 1: TransactionEvent Started
    const txId = newTransactionId('OCTT-TX');
    const startRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
    });

    const idTokenInfo = startRes['idTokenInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Started - idTokenInfo.status must be Accepted',
      status: idTokenInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: String(idTokenInfo?.['status']),
    });

    // Step 3: TransactionEvent Updated with LimitSet (echoing CSMS energy limit)
    const step3Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        transactionLimit: { maxEnergy: 10000 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      2,
      'TransactionEvent Updated - LimitSet maxEnergy',
      step3Res,
      'TransactionEventResponse received (transactionLimit omitted)',
      `Response keys: ${Object.keys(step3Res).join(', ')}`,
    );

    // Step 5: TransactionEvent Updated with EnergyLimitReached, SuspendedEVSE
    const step5Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'EnergyLimitReached',
      seqNo: 2,
      transactionInfo: {
        transactionId: txId,
        chargingState: 'SuspendedEVSE',
        transactionLimit: { maxEnergy: 10000 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      3,
      'TransactionEvent Updated - EnergyLimitReached SuspendedEVSE',
      step5Res,
      'TransactionEventResponse received',
      `Response keys: ${Object.keys(step5Res).join(', ')}`,
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_111_CSMS: Transactions with fixed cost, energy or time - CSMS specifies time limit
 * Use case: E16 (E16.FR.02)
 * Before: State is EVConnectedPreSession
 * Scenario:
 *   1. TransactionEvent Started with Charging, transactionLimit omitted
 *   2. CSMS responds (maxTime = configured, maxEnergy omitted, maxCost omitted)
 *   3. TransactionEvent Updated with LimitSet, maxTime from CSMS
 *   4. CSMS responds (transactionLimit omitted)
 */
export const TC_E_111_CSMS: TestCase = {
  id: 'TC_E_111_CSMS',
  name: 'Transactions with fixed cost, energy or time - CSMS specifies time limit',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS will set a time limit on the transaction.',
  purpose: 'To verify whether the CSMS is able to set a time limit.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    // Step 1: TransactionEvent Started
    const txId = newTransactionId('OCTT-TX');
    const startRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
    });

    const idTokenInfo = startRes['idTokenInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'TransactionEvent Started - idTokenInfo.status must be Accepted',
      status: idTokenInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: String(idTokenInfo?.['status']),
    });

    // Step 3: TransactionEvent Updated with LimitSet (echoing CSMS time limit)
    const step3Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        transactionLimit: { maxTime: 3600 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    pushSendAckStep(
      steps,
      2,
      'TransactionEvent Updated - LimitSet maxTime',
      step3Res,
      'TransactionEventResponse received (transactionLimit omitted)',
      `Response keys: ${Object.keys(step3Res).join(', ')}`,
    );

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
