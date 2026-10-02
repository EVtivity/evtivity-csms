// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_005_1_CSMS: TestCase = {
  id: 'TC_005_1_CSMS',
  name: 'EV Side Disconnected - StopTransactionOnEVSideDisconnect (1.6)',
  module: 'core',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Stop the transaction when the cable is disconnected at EV side.',
  purpose:
    'Verify the CSMS handles StatusNotification SuspendedEV, StopTransaction EVDisconnected, and status transitions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;
    const idTag = ctx.tokens.valid;
    const timestamp = new Date().toISOString();

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    // Reusable State Charging: the CSMS must accept the idTag in Authorize.conf
    // and StartTransaction.conf (TC_003_CSMS tool validations).
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp,
    });
    const authResp = await ctx.client.sendCall('Authorize', { idTag });
    const authStatus = (authResp['idTagInfo'] as Record<string, unknown> | undefined)?.['status'];
    steps.push({
      step: 1,
      description: 'Charging state: Authorize.conf idTagInfo.status',
      status: authStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(authStatus)}`,
    });
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp,
    });
    const startStatus = (startResp['idTagInfo'] as Record<string, unknown> | undefined)?.['status'];
    steps.push({
      step: 2,
      description: 'Charging state: StartTransaction.conf idTagInfo.status',
      status: startStatus === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startStatus)}`,
    });
    const transactionId = startResp['transactionId'] as number;
    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp,
    });

    // StatusNotification SuspendedEV (cable disconnected at EV side)
    const snResp1 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'SuspendedEV',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 3,
      description: 'Send StatusNotification (SuspendedEV)',
      status: snResp1 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp1 !== undefined ? 'Response received' : 'No response',
    });

    // StopTransaction with reason EVDisconnected
    const stopResp = await ctx.client.sendCall('StopTransaction', {
      transactionId,
      idTag,
      meterStop: 1000,
      timestamp: new Date().toISOString(),
      reason: 'EVDisconnected',
    });
    steps.push({
      step: 4,
      description: 'Send StopTransaction (reason: EVDisconnected)',
      status: stopResp !== undefined ? 'passed' : 'failed',
      expected: 'StopTransaction.conf received',
      actual: stopResp !== undefined ? 'Response received' : 'No response',
    });

    // StatusNotification Finishing
    const snResp2 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Finishing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 5,
      description: 'Send StatusNotification (Finishing)',
      status: snResp2 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp2 !== undefined ? 'Response received' : 'No response',
    });

    // StatusNotification Available (cable unplugged from CP)
    const snResp3 = await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 6,
      description: 'Send StatusNotification (Available)',
      status: snResp3 !== undefined ? 'passed' : 'failed',
      expected: 'StatusNotification.conf received',
      actual: snResp3 !== undefined ? 'Response received' : 'No response',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
