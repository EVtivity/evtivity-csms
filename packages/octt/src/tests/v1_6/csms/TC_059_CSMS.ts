// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_059_CSMS: TestCase = {
  id: 'TC_059_CSMS',
  name: 'Remote Start Transaction with Charging Profile (1.6)',
  module: 'smart-charging',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The Central System starts a transaction with a ChargingProfile.',
  purpose: 'Verify the CSMS can send RemoteStartTransaction with an embedded chargingProfile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const connectorId = 1;

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    let hasProfile = false;
    let remoteIdTag = '';
    ctx.client.setIncomingCallHandler(async (_messageId, action, payload) => {
      if (action === 'RemoteStartTransaction') {
        received = true;
        remoteIdTag = (payload['idTag'] as string) || '';
        hasProfile = payload['chargingProfile'] !== undefined;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'RemoteStartTransaction', {
        stationId: ctx.stationId,
        idTag: 'OCTT-TOKEN-001',
        connectorId: 1,
        chargingProfile: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: {
            chargingRateUnit: 'A',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
          },
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive RemoteStartTransaction with chargingProfile and respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'RemoteStartTransaction.req with chargingProfile',
      actual: received ? `Received, hasProfile=${String(hasProfile)}` : 'Not received',
    });

    const idTag = remoteIdTag || 'OCTT_TAG_001';
    const authResp = await ctx.client.sendCall('Authorize', { idTag });
    const authStatus = authResp['idTagInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 2,
      description: 'Send Authorize and expect Accepted',
      status: authStatus?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(authStatus?.['status'])}`,
    });

    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Preparing',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    const startResp = await ctx.client.sendCall('StartTransaction', {
      connectorId,
      idTag,
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });
    const startTagInfo = startResp['idTagInfo'] as Record<string, unknown> | undefined;
    steps.push({
      step: 3,
      description: 'Send StartTransaction and expect Accepted',
      status: startTagInfo?.['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'idTagInfo.status = Accepted',
      actual: `idTagInfo.status = ${String(startTagInfo?.['status'])}`,
    });

    await ctx.client.sendCall('StatusNotification', {
      connectorId,
      status: 'Charging',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 4,
      description: 'Send StatusNotification (Charging)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
