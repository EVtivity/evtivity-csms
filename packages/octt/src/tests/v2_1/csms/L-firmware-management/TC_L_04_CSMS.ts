// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_L_21_CSMS: TestCase = {
  id: 'TC_L_21_CSMS',
  name: 'Unpublish Firmware - Unpublished',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Stop serving a firmware update to connected Charging Stations.',
  purpose: 'To verify the CSMS is able to unpublish a firmware on the local controller.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'UnpublishFirmware') {
        received = true;
        return { status: 'Unpublished' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UnpublishFirmware', {
        stationId: ctx.stationId,
        checksum: 'abc123',
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends UnpublishFirmwareRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: 'Respond with status Unpublished',
      status: received ? 'passed' : 'failed',
      expected: 'Response sent',
      actual: received ? 'Sent' : 'Not sent',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_L_22_CSMS: TestCase = {
  id: 'TC_L_22_CSMS',
  name: 'Unpublish Firmware - NoFirmware',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Stop serving a firmware update when no firmware is published.',
  purpose: 'To verify the CSMS handles NoFirmware response for unpublish firmware.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'UnpublishFirmware') {
        received = true;
        return { status: 'NoFirmware' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UnpublishFirmware', {
        stationId: ctx.stationId,
        checksum: 'abc123',
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends UnpublishFirmwareRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

export const TC_L_23_CSMS: TestCase = {
  id: 'TC_L_23_CSMS',
  name: 'Unpublish Firmware - Download Ongoing',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Stop serving a firmware update while download is ongoing.',
  purpose: 'To verify the CSMS handles NoFirmware response when download is ongoing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'UnpublishFirmware') {
        received = true;
        return { status: 'NoFirmware' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UnpublishFirmware', {
        stationId: ctx.stationId,
        checksum: 'abc123',
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends UnpublishFirmwareRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    steps.push({
      step: 2,
      description: 'Respond with status NoFirmware',
      status: received ? 'passed' : 'failed',
      expected: 'Response sent',
      actual: received ? 'Sent' : 'Not sent',
    });
    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
