// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// E01(S2): Start transaction options - EVConnected
export const TC_E_09_CSMS: TestCase = {
  id: 'TC_E_09_CSMS',
  name: 'Start transaction options - EVConnected',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a transaction when the EV and EVSE are connected (EVConnected trigger).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Step 1: Send StatusNotification with Occupied
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Occupied',
        evseId: 1,
        connectorId: 1,
      });
      steps.push({
        step: 1,
        description: 'Send StatusNotification with connectorStatus Occupied',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send StatusNotification with connectorStatus Occupied',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 2: Send TransactionEvent Started with EVConnected chargingState
    const txId = `OCTT-TX-${String(Date.now())}`;
    try {
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'CablePluggedIn',
        seqNo: 0,
        transactionInfo: {
          transactionId: txId,
          chargingState: 'EVConnected',
        },
        evse: { id: 1, connectorId: 1 },
      });
      steps.push({
        step: 2,
        description:
          'Send TransactionEvent Started with triggerReason CablePluggedIn and chargingState EVConnected',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(txRes).join(', ')}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'Send TransactionEvent Started with chargingState EVConnected',
        status: 'failed',
        expected: 'TransactionEventResponse received',
        actual: 'Error',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// E01(S4): Start transaction options - DataSigned
export const TC_E_11_CSMS: TestCase = {
  id: 'TC_E_11_CSMS',
  name: 'Start transaction options - DataSigned',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a transaction when the signed meter data is received (SignedDataReceived trigger).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Step 1: Authorize
    try {
      const authRes = await ctx.client.sendCall('Authorize', {
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      });
      const idTokenStatus = (authRes['idTokenInfo'] as Record<string, unknown> | undefined)?.[
        'status'
      ] as string | undefined;
      steps.push({
        step: 1,
        description: 'Send AuthorizeRequest',
        status: idTokenStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'idTokenInfo.status = Accepted',
        actual: `idTokenInfo.status = ${String(idTokenStatus)}`,
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send AuthorizeRequest',
        status: 'failed',
        expected: 'AuthorizeResponse received',
        actual: 'Error',
      });
    }

    // Step 2: Send StatusNotification Occupied
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Occupied',
      evseId: 1,
      connectorId: 1,
    });

    // Step 3: Send TransactionEvent Started with SignedDataReceived trigger
    const txId = `OCTT-TX-${String(Date.now())}`;
    try {
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'SignedDataReceived',
        seqNo: 0,
        transactionInfo: {
          transactionId: txId,
          chargingState: 'EVConnected',
        },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: 0,
                context: 'Transaction.Begin',
                measurand: 'Energy.Active.Import.Register',
                signedMeterValue: {
                  signedMeterData: 'OCTT-SIGNED-DATA',
                  signingMethod: 'RSASSA-PKCS1-v1_5',
                  encodingMethod: 'UTF8',
                  publicKey: 'OCTT-PUBLIC-KEY',
                },
              },
            ],
          },
        ],
      });
      const idTokenInfo = txRes['idTokenInfo'] as Record<string, unknown> | undefined;
      const txStatus = idTokenInfo?.['status'] as string | undefined;
      steps.push({
        step: 2,
        description: 'Send TransactionEvent Started with SignedDataReceived trigger',
        status: txStatus === 'Accepted' || txStatus === undefined ? 'passed' : 'failed',
        expected: 'TransactionEventResponse received',
        actual: `idTokenInfo.status = ${String(txStatus ?? 'not present')}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'Send TransactionEvent Started with SignedDataReceived trigger',
        status: 'failed',
        expected: 'TransactionEventResponse received',
        actual: 'Error',
      });
    }

    // Step 4: Send TransactionEvent Updated with ChargingStateChanged
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Updated',
        timestamp: new Date().toISOString(),
        triggerReason: 'ChargingStateChanged',
        seqNo: 1,
        transactionInfo: {
          transactionId: txId,
          chargingState: 'Charging',
        },
      });
      steps.push({
        step: 3,
        description: 'Send TransactionEvent Updated with chargingState Charging',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Send TransactionEvent Updated with chargingState Charging',
        status: 'failed',
        expected: 'TransactionEventResponse received',
        actual: 'Error',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// E01(S1): Start transaction options - ParkingBayOccupied (EVDetected)
export const TC_E_12_CSMS: TestCase = {
  id: 'TC_E_12_CSMS',
  name: 'Start transaction options - ParkingBayOccupied',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.x has a flexible transaction mechanism that allows the transaction start and stop points to be configured.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station that starts a transaction when an EV is detected in the parking bay (EVDetected trigger).',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Send TransactionEvent Started with EVDetected trigger
    const txId = `OCTT-TX-${String(Date.now())}`;
    try {
      const txRes = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'EVDetected',
        seqNo: 0,
        transactionInfo: {
          transactionId: txId,
          chargingState: 'EVConnected',
        },
      });
      steps.push({
        step: 1,
        description: 'Send TransactionEvent Started with triggerReason EVDetected',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(txRes).join(', ')}`,
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send TransactionEvent Started with triggerReason EVDetected',
        status: 'failed',
        expected: 'TransactionEventResponse received',
        actual: 'Error',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// E01: Reset Sequence Number - CSMS accepting seqNo = 0 at start of transaction
export const TC_E_53_CSMS: TestCase = {
  id: 'TC_E_53_CSMS',
  name: 'Reset Sequence Number - CSMS accepting seqNo = 0 at start of transaction',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'OCPP 2.0.1 Edition 2 recommends that seqNo starts at 0 for every transaction. CSMS must accept seqNo = 0 for each new transaction.',
  purpose: 'To verify if the CSMS accepts that a new transaction starts with a seqNo = 0.',
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

    // Transaction 1: start with seqNo = 0
    const txId1 = `OCTT-TX-${String(Date.now())}-1`;
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'Authorized',
        seqNo: 0,
        transactionInfo: { transactionId: txId1, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      });
      steps.push({
        step: 1,
        description: 'Transaction 1: TransactionEvent Started with seqNo = 0',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Transaction 1: TransactionEvent Started with seqNo = 0',
        status: 'failed',
        expected: 'TransactionEventResponse received',
        actual: 'Error',
      });
    }

    // End transaction 1
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Ended',
        timestamp: new Date().toISOString(),
        triggerReason: 'EVDeparted',
        seqNo: 1,
        transactionInfo: { transactionId: txId1, stoppedReason: 'EVDisconnected' },
        evse: { id: 1, connectorId: 1 },
      });
      steps.push({
        step: 2,
        description: 'Transaction 1: TransactionEvent Ended',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 2,
        description: 'Transaction 1: TransactionEvent Ended',
        status: 'failed',
        expected: 'TransactionEventResponse received',
        actual: 'Error',
      });
    }

    // Transaction 2: also start with seqNo = 0 (reset per transaction)
    const txId2 = `OCTT-TX-${String(Date.now())}-2`;
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'Authorized',
        seqNo: 0,
        transactionInfo: { transactionId: txId2, chargingState: 'Charging' },
        evse: { id: 1, connectorId: 1 },
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      });
      steps.push({
        step: 3,
        description:
          'Transaction 2: TransactionEvent Started with seqNo = 0 (CSMS must accept reset)',
        status: 'passed',
        expected: 'CSMS accepts seqNo = 0 for new transaction',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Transaction 2: TransactionEvent Started with seqNo = 0',
        status: 'failed',
        expected: 'CSMS accepts seqNo = 0',
        actual: 'Error - CSMS rejected seqNo = 0',
      });
    }

    // End transaction 2
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Ended',
        timestamp: new Date().toISOString(),
        triggerReason: 'EVDeparted',
        seqNo: 1,
        transactionInfo: { transactionId: txId2, stoppedReason: 'EVDisconnected' },
        evse: { id: 1, connectorId: 1 },
      });
      steps.push({
        step: 4,
        description: 'Transaction 2: TransactionEvent Ended',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 4,
        description: 'Transaction 2: TransactionEvent Ended',
        status: 'failed',
        expected: 'TransactionEventResponse received',
        actual: 'Error',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
