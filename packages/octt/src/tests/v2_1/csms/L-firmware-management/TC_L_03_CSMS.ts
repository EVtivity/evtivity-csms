// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// L03: Publish Firmware - Published
export const TC_L_17_CSMS: TestCase = {
  id: 'TC_L_17_CSMS',
  name: 'Publish Firmware - Published',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The Local Controller downloads and publishes a firmware update.',
  purpose: 'To verify the CSMS is able to publish a firmware on the local controller.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedPublishFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'PublishFirmware') {
        receivedPublishFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'PublishFirmware', {
        stationId: ctx.stationId,
        location: 'https://example.com/fw.bin',
        checksum: 'abc123',
        requestId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends PublishFirmwareRequest',
      status: receivedPublishFirmware ? 'passed' : 'failed',
      expected: 'PublishFirmwareRequest received',
      actual: receivedPublishFirmware ? 'Received' : 'Not received',
    });

    if (!receivedPublishFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = ['Downloading', 'Downloaded', 'ChecksumVerified', 'Published'];
    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        const payload: Record<string, unknown> = { status: fwStatus };
        if (fwStatus === 'Published') {
          payload['location'] = ['https://firmware.example.com/fw-2.0.0.bin'];
        }
        await ctx.client.sendCall('PublishFirmwareStatusNotification', payload);
        steps.push({
          step: i + 2,
          description: `Send PublishFirmwareStatusNotification with status ${fwStatus}`,
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send PublishFirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// L03: Publish Firmware - Download failed
export const TC_L_24_CSMS: TestCase = {
  id: 'TC_L_24_CSMS',
  name: 'Publish Firmware - Download failed',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The Local Controller fails to download a firmware update.',
  purpose: 'To verify the CSMS handles DownloadFailed status for publish firmware.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedPublishFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'PublishFirmware') {
        receivedPublishFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'PublishFirmware', {
        stationId: ctx.stationId,
        location: 'https://example.com/fw.bin',
        checksum: 'abc123',
        requestId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends PublishFirmwareRequest',
      status: receivedPublishFirmware ? 'passed' : 'failed',
      expected: 'PublishFirmwareRequest received',
      actual: receivedPublishFirmware ? 'Received' : 'Not received',
    });

    if (!receivedPublishFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = ['Downloading', 'DownloadFailed'];
    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        await ctx.client.sendCall('PublishFirmwareStatusNotification', { status: fwStatus });
        steps.push({
          step: i + 2,
          description: `Send PublishFirmwareStatusNotification with status ${fwStatus}`,
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send PublishFirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// L03: Publish Firmware - Invalid Checksum
export const TC_L_19_CSMS: TestCase = {
  id: 'TC_L_19_CSMS',
  name: 'Publish Firmware - Invalid Checksum',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The Local Controller reports an invalid checksum during firmware publish.',
  purpose: 'To verify the CSMS handles InvalidChecksum status for publish firmware.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedPublishFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'PublishFirmware') {
        receivedPublishFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'PublishFirmware', {
        stationId: ctx.stationId,
        location: 'https://example.com/fw.bin',
        checksum: 'abc123',
        requestId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends PublishFirmwareRequest',
      status: receivedPublishFirmware ? 'passed' : 'failed',
      expected: 'PublishFirmwareRequest received',
      actual: receivedPublishFirmware ? 'Received' : 'Not received',
    });

    if (!receivedPublishFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = ['Downloading', 'Downloaded', 'InvalidChecksum'];
    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        await ctx.client.sendCall('PublishFirmwareStatusNotification', { status: fwStatus });
        steps.push({
          step: i + 2,
          description: `Send PublishFirmwareStatusNotification with status ${fwStatus}`,
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send PublishFirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// L03: Publish Firmware - PublishFailed
export const TC_L_20_CSMS: TestCase = {
  id: 'TC_L_20_CSMS',
  name: 'Publish Firmware - PublishFailed',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The Local Controller reports publish failed for firmware update.',
  purpose: 'To verify the CSMS handles PublishFailed status for publish firmware.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedPublishFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'PublishFirmware') {
        receivedPublishFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'PublishFirmware', {
        stationId: ctx.stationId,
        location: 'https://example.com/fw.bin',
        checksum: 'abc123',
        requestId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends PublishFirmwareRequest',
      status: receivedPublishFirmware ? 'passed' : 'failed',
      expected: 'PublishFirmwareRequest received',
      actual: receivedPublishFirmware ? 'Received' : 'Not received',
    });

    if (!receivedPublishFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = ['Downloading', 'Downloaded', 'ChecksumVerified', 'PublishFailed'];
    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        await ctx.client.sendCall('PublishFirmwareStatusNotification', { status: fwStatus });
        steps.push({
          step: i + 2,
          description: `Send PublishFirmwareStatusNotification with status ${fwStatus}`,
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send PublishFirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
