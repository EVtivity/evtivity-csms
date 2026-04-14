// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_044_1_CSMS: TestCase = {
  id: 'TC_044_1_CSMS',
  name: 'Firmware Update - Download and Install (1.6)',
  module: 'firmware',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'The firmware of a Charge Point is updated successfully.',
  purpose:
    'Verify the CSMS can trigger UpdateFirmware and handle the full firmware update lifecycle.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let updateFirmwareReceived = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'UpdateFirmware') {
        updateFirmwareReceived = true;
        return {};
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v16', 'UpdateFirmware', {
        stationId: ctx.stationId,
        location: 'https://example.com/fw.bin',
        retrieveDate: new Date().toISOString(),
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'Receive UpdateFirmware from CSMS',
      status: updateFirmwareReceived ? 'passed' : 'failed',
      expected: 'UpdateFirmware.req received',
      actual: updateFirmwareReceived ? 'Received' : 'Not received',
    });

    // Downloading
    await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Downloading' });
    steps.push({
      step: 2,
      description: 'Send FirmwareStatusNotification (Downloading)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    // Downloaded
    await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Downloaded' });
    steps.push({
      step: 3,
      description: 'Send FirmwareStatusNotification (Downloaded)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    // StatusNotification Unavailable
    await ctx.client.sendCall('StatusNotification', {
      connectorId: 1,
      status: 'Unavailable',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    steps.push({
      step: 4,
      description: 'Send StatusNotification (Unavailable)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    // Installing
    await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Installing' });
    steps.push({
      step: 5,
      description: 'Send FirmwareStatusNotification (Installing)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    // Reboot
    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });
    steps.push({
      step: 6,
      description: 'Send BootNotification after reboot',
      status: bootResp['status'] === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(bootResp['status'])}`,
    });

    // StatusNotification Available
    await ctx.client.sendCall('StatusNotification', {
      connectorId: 1,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });

    // Installed
    await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Installed' });
    steps.push({
      step: 7,
      description: 'Send FirmwareStatusNotification (Installed)',
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
