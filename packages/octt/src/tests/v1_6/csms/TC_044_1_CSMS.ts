// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';
import { pushSendAckStep } from '../../../csms-test-helpers.js';

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
    const resp2 = await ctx.client.sendCall('FirmwareStatusNotification', {
      status: 'Downloading',
    });
    pushSendAckStep(steps, 2, 'Send FirmwareStatusNotification (Downloading)', resp2);

    // Downloaded
    const resp3 = await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Downloaded' });
    pushSendAckStep(steps, 3, 'Send FirmwareStatusNotification (Downloaded)', resp3);

    // StatusNotification Unavailable
    const resp4 = await ctx.client.sendCall('StatusNotification', {
      connectorId: 1,
      status: 'Unavailable',
      errorCode: 'NoError',
      timestamp: new Date().toISOString(),
    });
    pushSendAckStep(steps, 4, 'Send StatusNotification (Unavailable)', resp4);

    // Installing
    const resp5 = await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Installing' });
    pushSendAckStep(steps, 5, 'Send FirmwareStatusNotification (Installing)', resp5);

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
    const resp7 = await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Installed' });
    pushSendAckStep(steps, 7, 'Send FirmwareStatusNotification (Installed)', resp7);

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
