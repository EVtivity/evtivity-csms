// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../types.js';

export const TC_044_2_CSMS: TestCase = {
  id: 'TC_044_2_CSMS',
  name: 'Firmware Update - Download Failed (1.6)',
  module: 'firmware',
  version: 'ocpp1.6',
  sut: 'csms',
  description: 'Firmware download fails during update.',
  purpose: 'Verify the CSMS handles FirmwareStatusNotification with DownloadFailed.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargePointVendor: 'OCTT',
      chargePointModel: 'OCTT-Virtual-16',
    });

    let received = false;
    ctx.client.setIncomingCallHandler(async (_messageId, action, _payload) => {
      if (action === 'UpdateFirmware') {
        received = true;
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
      status: received ? 'passed' : 'failed',
      expected: 'UpdateFirmware.req received',
      actual: received ? 'Received' : 'Not received',
    });

    await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Downloading' });
    steps.push({
      step: 2,
      description: 'Send FirmwareStatusNotification (Downloading)',
      status: 'passed',
      expected: 'Response received',
      actual: 'Response received',
    });

    await ctx.client.sendCall('FirmwareStatusNotification', { status: 'DownloadFailed' });
    steps.push({
      step: 3,
      description: 'Send FirmwareStatusNotification (DownloadFailed)',
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
