// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_P_02_CSMS: TestCase = {
  id: 'TC_P_02_CSMS',
  name: 'Data Transfer to CSMS - Rejected/Unknown',
  module: 'P-data-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS handles a DataTransferRequest it does not support.',
  purpose: 'To verify the CSMS responds with UnknownVendorId, UnknownMessageId, or Rejected.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      const resp = await ctx.client.sendCall('DataTransfer', {
        vendorId: 'UnknownVendor',
        messageId: 'UnknownMessage',
      });
      const status = resp['status'] as string;
      const valid = ['UnknownVendorId', 'UnknownMessageId', 'Rejected'].includes(status);
      steps.push({
        step: 1,
        description: 'Send DataTransferRequest with unknown vendor',
        status: valid ? 'passed' : 'failed',
        expected: 'status = UnknownVendorId/UnknownMessageId/Rejected',
        actual: `status = ${status}`,
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send DataTransferRequest',
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

export const TC_P_03_CSMS: TestCase = {
  id: 'TC_P_03_CSMS',
  name: 'CustomData - Receive custom data',
  module: 'P-data-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS handles messages containing customData fields.',
  purpose: 'To verify the CSMS accepts messages with customData without errors.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 1,
        connectorId: 1,
        customData: { vendorId: 'TestVendor', testField: 'testValue' },
      });
      steps.push({
        step: 1,
        description: 'Send StatusNotification with customData',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send StatusNotification with customData',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }
    try {
      await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Started',
        timestamp: new Date().toISOString(),
        triggerReason: 'Authorized',
        seqNo: 0,
        transactionInfo: {
          transactionId: 'test-tx-custom-1',
          chargingState: 'EVConnected',
          customData: { vendorId: 'TestVendor' },
        },
        customData: { vendorId: 'TestVendor', customField: 123 },
      });
      steps.push({
        step: 2,
        description: 'Send TransactionEvent with customData',
        status: 'passed',
        expected: 'Response received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 2,
        description: 'Send TransactionEvent with customData',
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
