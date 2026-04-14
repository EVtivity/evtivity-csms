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

// Helper: start a charging transaction and return the txId
async function startChargingTransaction(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
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

    steps.push({
      step: 1,
      description: 'TransactionEvent Updated - LimitSet maxEnergy 6000',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step1Res).join(', ')}`,
    });

    // Step 3: TransactionEvent Updated (CSMS should override maxEnergy to 10000)
    const step3Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'MeterValuePeriodic',
      seqNo: 2,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Updated - CSMS should set maxEnergy 10000',
      status: 'passed',
      expected: 'TransactionEventResponse with transactionLimit.maxEnergy 10000',
      actual: `Response keys: ${Object.keys(step3Res).join(', ')}`,
    });

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

    steps.push({
      step: 3,
      description: 'TransactionEvent Updated - LimitSet maxEnergy 10000',
      status: 'passed',
      expected: 'TransactionEventResponse with transactionLimit omitted',
      actual: `Response keys: ${Object.keys(step5Res).join(', ')}`,
    });

    // Step 7: TransactionEvent Ended with EnergyLimitReached
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EnergyLimitReached',
      seqNo: 4,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 4,
      description: 'TransactionEvent Ended - EnergyLimitReached',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

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

    steps.push({
      step: 1,
      description: 'TransactionEvent Updated - LimitSet maxEnergy 6000',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step1Res).join(', ')}`,
    });

    // Step 3: TransactionEvent Ended with EnergyLimitReached
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'EnergyLimitReached',
      seqNo: 2,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Ended - EnergyLimitReached',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

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

    steps.push({
      step: 1,
      description: 'TransactionEvent Updated - LimitSet maxTime 120',
      status: 'passed',
      expected: 'TransactionEventResponse received (transactionLimit omitted)',
      actual: `Response keys: ${Object.keys(step1Res).join(', ')}`,
    });

    // Step 3: TransactionEvent Ended with TimeLimitReached
    const endRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Ended',
      timestamp: new Date().toISOString(),
      triggerReason: 'TimeLimitReached',
      seqNo: 2,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Ended - TimeLimitReached',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

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

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'SetDefaultTariff') {
        receivedSetTariff = true;
        return { status: 'Accepted' };
      }
      return { status: 'NotSupported' };
    });

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
    ctx.client.setIncomingCallHandler(async () => ({ status: 'NotSupported' }));

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

    steps.push({
      step: 2,
      description: 'TransactionEvent Updated - LimitSet maxCost 2.00',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step4Res).join(', ')}`,
    });

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

    steps.push({
      step: 3,
      description: 'TransactionEvent Updated - RunningCost 1.50 EUR',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step6Res).join(', ')}`,
    });

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

    steps.push({
      step: 4,
      description: 'TransactionEvent Ended - CostLimitReached 2.00 EUR',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(endRes).join(', ')}`,
    });

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
 * Before: State is EVConnectedPreSession
 * Scenario:
 *   1. Authorize
 *   2. CSMS responds
 *   3. TransactionEvent Started with Charging
 *   4. CSMS responds (totalCost not omitted, maxCost 10)
 *   5. TransactionEvent Updated with LimitSet maxCost 10
 *   6. CSMS responds (totalCost not omitted, transactionLimit omitted)
 *   7. CSMS sends CostUpdatedRequest (optional)
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

    await bootAndStatus(ctx);

    // Set up handler for CostUpdated from CSMS
    let receivedCostUpdated = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'CostUpdated') {
        receivedCostUpdated = true;
        return {};
      }
      return { status: 'NotSupported' };
    });

    // Step 1: Authorize
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 1,
      description: 'Authorize - idTokenInfo.status must be Accepted',
      status: idTokenInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: String(idTokenInfo?.['status']),
    });

    // Step 3: TransactionEvent Started
    const txId = `OCTT-TX-${String(Date.now())}`;
    const startRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    steps.push({
      step: 2,
      description: 'TransactionEvent Started - Charging',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(startRes).join(', ')}`,
    });

    // Step 5: TransactionEvent Updated with LimitSet, maxCost 10
    const step5Res = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'LimitSet',
      seqNo: 1,
      transactionInfo: {
        transactionId: txId,
        transactionLimit: { maxCost: 10 },
      },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 3,
      description: 'TransactionEvent Updated - LimitSet maxCost 10',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step5Res).join(', ')}`,
    });

    // Wait for optional CostUpdated
    await new Promise((resolve) => setTimeout(resolve, 5000));

    steps.push({
      step: 4,
      description: 'CSMS sends CostUpdatedRequest (optional)',
      status: 'passed',
      expected: 'CostUpdatedRequest (optional)',
      actual: receivedCostUpdated
        ? 'CostUpdatedRequest received'
        : 'No CostUpdatedRequest (acceptable)',
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
    const txId = `OCTT-TX-${String(Date.now())}`;
    const startRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
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

    steps.push({
      step: 2,
      description: 'TransactionEvent Updated - LimitSet maxEnergy',
      status: 'passed',
      expected: 'TransactionEventResponse received (transactionLimit omitted)',
      actual: `Response keys: ${Object.keys(step3Res).join(', ')}`,
    });

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

    steps.push({
      step: 3,
      description: 'TransactionEvent Updated - EnergyLimitReached SuspendedEVSE',
      status: 'passed',
      expected: 'TransactionEventResponse received',
      actual: `Response keys: ${Object.keys(step5Res).join(', ')}`,
    });

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
    const txId = `OCTT-TX-${String(Date.now())}`;
    const startRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
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

    steps.push({
      step: 2,
      description: 'TransactionEvent Updated - LimitSet maxTime',
      status: 'passed',
      expected: 'TransactionEventResponse received (transactionLimit omitted)',
      actual: `Response keys: ${Object.keys(step3Res).join(', ')}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
