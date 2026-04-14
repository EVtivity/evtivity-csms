// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_S_103_CSMS: TestCase = {
  id: 'TC_S_103_CSMS',
  name: 'Battery Swap - Remote Start - enough batteries available',
  module: 'S-battery-swapping',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'CSMS supports a full battery swapping flow.',
  purpose: 'To verify the CSMS handles a complete battery swap lifecycle.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let requestBatterySwapReceived = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'RequestBatterySwap') {
        requestBatterySwapReceived = true;
        return { status: 'Accepted' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'RequestBatterySwap', {
        stationId: ctx.stationId,
        requestId: 1,
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends RequestBatterySwapRequest',
      status: requestBatterySwapReceived ? 'passed' : 'failed',
      expected: 'Request received',
      actual: requestBatterySwapReceived ? 'Received' : 'Not received',
    });

    if (!requestBatterySwapReceived) {
      return { status: 'failed', durationMs: 0, steps };
    }

    // Step 3: StatusNotification for slot status change (batteries inserted)
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Occupied',
        evseId: 1,
        connectorId: 1,
      });
      steps.push({
        step: 3,
        description: 'Send StatusNotification Occupied EVSE 1',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Send StatusNotification Occupied EVSE 1',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 5: TransactionEvent Started for EVSE 1
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'CablePluggedIn',
        seqNo: 0,
        idToken: { idToken: '', type: 'NoAuthorization' },
        evse: { id: 1, connectorId: 1 },
        transactionInfo: { transactionId: '111-222-333-444-3', chargingState: 'EVConnected' },
      });
      steps.push({
        step: 5,
        description: 'Send TransactionEvent Started EVSE 1',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 5,
        description: 'Send TransactionEvent Started EVSE 1',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 7: StatusNotification for slot status change
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Occupied',
        evseId: 2,
        connectorId: 1,
      });
      steps.push({
        step: 7,
        description: 'Send StatusNotification Occupied EVSE 2',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 7,
        description: 'Send StatusNotification Occupied EVSE 2',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 9: TransactionEvent Started for EVSE 2
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'CablePluggedIn',
        seqNo: 0,
        idToken: { idToken: '', type: 'NoAuthorization' },
        evse: { id: 2, connectorId: 1 },
        transactionInfo: { transactionId: '111-222-333-444-4', chargingState: 'EVConnected' },
      });
      steps.push({
        step: 9,
        description: 'Send TransactionEvent Started EVSE 2',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 9,
        description: 'Send TransactionEvent Started EVSE 2',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 11: BatterySwap BatteryIn
    try {
      await ctx.client.sendCall('BatterySwap', {
        eventType: 'BatteryIn',
        requestId: 1,
        idToken: { idToken: 'OCTT-TOKEN-01', type: 'ISO14443' },
        batteryData: [
          { evseId: 1, serialNumber: '1234', soC: 23, soH: 85 },
          { evseId: 2, serialNumber: '5678', soC: 45, soH: 87 },
        ],
      });
      steps.push({
        step: 11,
        description: 'Send BatterySwapRequest BatteryIn',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 11,
        description: 'Send BatterySwapRequest BatteryIn',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 13: TransactionEvent Ended for tx 3 (EVSE 1)
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Ended',
        timestamp: new Date().toISOString(),
        triggerReason: 'EnergyLimitReached',
        seqNo: 1,
        idToken: { idToken: '', type: 'NoAuthorization' },
        transactionInfo: {
          transactionId: '111-222-333-444-3',
          chargingState: 'Idle',
          stoppedReason: 'EVDisconnected',
        },
      });
      steps.push({
        step: 13,
        description: 'Send TransactionEvent Ended for tx 3',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 13,
        description: 'Send TransactionEvent Ended for tx 3',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 15: StatusNotification for slot status change (battery extracted from EVSE 1)
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 1,
        connectorId: 1,
      });
      steps.push({
        step: 15,
        description: 'Send StatusNotification Available EVSE 1',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 15,
        description: 'Send StatusNotification Available EVSE 1',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 17: TransactionEvent Ended for tx 4 (EVSE 2)
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Ended',
        timestamp: new Date().toISOString(),
        triggerReason: 'EnergyLimitReached',
        seqNo: 1,
        idToken: { idToken: '', type: 'NoAuthorization' },
        transactionInfo: {
          transactionId: '111-222-333-444-4',
          chargingState: 'Idle',
          stoppedReason: 'EVDisconnected',
        },
      });
      steps.push({
        step: 17,
        description: 'Send TransactionEvent Ended for tx 4',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 17,
        description: 'Send TransactionEvent Ended for tx 4',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 19: StatusNotification for slot status change (battery extracted from EVSE 2)
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 2,
        connectorId: 1,
      });
      steps.push({
        step: 19,
        description: 'Send StatusNotification Available EVSE 2',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 19,
        description: 'Send StatusNotification Available EVSE 2',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 21: BatterySwap BatteryOut
    try {
      await ctx.client.sendCall('BatterySwap', {
        eventType: 'BatteryOut',
        requestId: 1,
        idToken: { idToken: 'OCTT-TOKEN-01', type: 'ISO14443' },
        batteryData: [
          { evseId: 3, serialNumber: '4321', soC: 80, soH: 95 },
          { evseId: 4, serialNumber: '8765', soC: 85, soH: 78 },
        ],
      });
      steps.push({
        step: 21,
        description: 'Send BatterySwapRequest BatteryOut',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 21,
        description: 'Send BatterySwapRequest BatteryOut',
        status: 'failed',
        expected: 'Response received',
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
