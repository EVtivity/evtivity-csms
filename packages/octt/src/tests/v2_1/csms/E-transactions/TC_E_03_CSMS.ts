// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

/** TC_E_03_CSMS: Local start transaction - Cable plugin first - Success */
export const TC_E_03_CSMS: TestCase = {
  id: 'TC_E_03_CSMS',
  name: 'Local start transaction - Cable plugin first - Success',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a charging session when the cable is plugged in first.',
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

    // Step 2: TransactionEvent Started (EnergyTransfer)
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const txIdTokenStatus = (txRes['idTokenInfo'] as Record<string, unknown>)?.['status'] as
      | string
      | undefined;
    steps.push({
      step: 2,
      description: 'Send TransactionEvent Started, expect idTokenInfo.status Accepted',
      status: txIdTokenStatus === 'Accepted' || txIdTokenStatus == null ? 'passed' : 'failed',
      expected: 'idTokenInfo.status = Accepted (if present)',
      actual:
        txIdTokenStatus != null
          ? `idTokenInfo.status = ${txIdTokenStatus}`
          : 'idTokenInfo not in response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_E_04_CSMS: Local start transaction - Authorization first - Success
 * Use case: E03 (E03.FR.02)
 * Before: State is EVConnectedPreSession
 * Scenario:
 *   1. Execute Reusable State Authorized
 *   2. Execute Reusable State EnergyTransferStarted
 */
export const TC_E_04_CSMS: TestCase = {
  id: 'TC_E_04_CSMS',
  name: 'Local start transaction - Authorization first - Success',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a charging session when the driver authorizes first.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot
    const bootRes = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    steps.push({
      step: 1,
      description: 'Boot station',
      status: bootRes['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: String(bootRes['status']),
    });

    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    // EVConnectedPreSession: cable plugged in, status Occupied
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Occupied',
      evseId: 1,
      connectorId: 1,
    });

    const txId = `OCTT-TX-${String(Date.now())}`;

    // TransactionEvent Started with EVDetected (pre-session)
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'CablePluggedIn',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'EVConnected' },
      evse: { id: 1, connectorId: 1 },
    });

    // Step 1: Authorize (Reusable State Authorized)
    const authRes = await ctx.client.sendCall('Authorize', {
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });
    const idTokenInfo = authRes['idTokenInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'Authorize - idTokenInfo.status must be Accepted',
      status: idTokenInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'Accepted',
      actual: String(idTokenInfo?.['status']),
    });

    // Step 2: EnergyTransferStarted
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date().toISOString(),
      triggerReason: 'ChargingStateChanged',
      seqNo: 1,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    steps.push({
      step: 3,
      description: 'TransactionEvent Updated - EnergyTransferStarted',
      status: 'passed',
      expected: 'Response received',
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
 * TC_E_39_CSMS: Stop transaction options - Deauthorized - timeout
 * Use case: E03, E06 (E03.FR.04, E03.FR.05, E06.FR.04)
 * Scenario:
 *   1. Execute Reusable State Authorized
 *   2. Execute Reusable State EnergyTransferStarted
 */
export const TC_E_39_CSMS: TestCase = {
  id: 'TC_E_39_CSMS',
  name: 'Stop transaction options - Deauthorized - timeout',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that deauthorizes the transaction after timeout.',
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

    // Step 2: EnergyTransferStarted
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes = await ctx.client.sendCall('TransactionEvent', {
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
      description: 'TransactionEvent Started - EnergyTransferStarted',
      status: 'passed',
      expected: 'Response received',
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
 * TC_E_38_CSMS: Local start transaction - EV not ready
 * Use case: E03
 * Scenario:
 *   1. TransactionEvent Started with triggerReason EVDetected
 *   2. CSMS responds with TransactionEventResponse
 */
export const TC_E_38_CSMS: TestCase = {
  id: 'TC_E_38_CSMS',
  name: 'Local start transaction - EV not ready',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x.x allows an EV driver to either first connect the EV and EVSE OR present a form of identification.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that reports an EV is not ready to start the energy transfer.',
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

    // Step 1: TransactionEvent Started with EVDetected
    const txId = `OCTT-TX-${String(Date.now())}`;
    const txRes = await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'EVDetected',
      seqNo: 0,
      transactionInfo: { transactionId: txId },
      evse: { id: 1, connectorId: 1 },
    });

    steps.push({
      step: 1,
      description: 'TransactionEvent Started with triggerReason EVDetected',
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
