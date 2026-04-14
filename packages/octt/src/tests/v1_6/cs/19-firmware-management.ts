// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

export const TC_044_1_CS: CsTestCase = {
  id: 'TC_044_1_CS',
  name: 'Firmware Update - Download and Install',
  module: '19-firmware-management',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The firmware of a Charge Point is updated.',
  purpose: 'Check whether the Charge Point can update its firmware.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'FirmwareStatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    await ctx.server.sendCommand('UpdateFirmware', {
      location: 'http://example.com/firmware.bin',
      retrieveDate: new Date().toISOString(),
    });
    const fw1 = await ctx.server.waitForMessage('FirmwareStatusNotification', 60_000);
    steps.push({
      step: 3,
      description: 'FirmwareStatusNotification Downloading',
      status: (fw1['status'] as string) === 'Downloading' ? 'passed' : 'failed',
      expected: 'status = Downloading',
      actual: `status = ${String(fw1['status'])}`,
    });
    const fw2 = await ctx.server.waitForMessage('FirmwareStatusNotification', 60_000);
    steps.push({
      step: 5,
      description: 'FirmwareStatusNotification Downloaded',
      status: (fw2['status'] as string) === 'Downloaded' ? 'passed' : 'failed',
      expected: 'status = Downloaded',
      actual: `status = ${String(fw2['status'])}`,
    });
    const fw3 = await ctx.server.waitForMessage('FirmwareStatusNotification', 60_000);
    steps.push({
      step: 7,
      description: 'FirmwareStatusNotification Installing',
      status: (fw3['status'] as string) === 'Installing' ? 'passed' : 'failed',
      expected: 'status = Installing',
      actual: `status = ${String(fw3['status'])}`,
    });
    const boot = await ctx.server.waitForMessage('BootNotification', 60_000);
    steps.push({
      step: 9,
      description: 'BootNotification after firmware install',
      status: boot !== undefined ? 'passed' : 'failed',
      expected: 'BootNotification received',
      actual: boot !== undefined ? 'Received' : 'Not received',
    });
    const fw4 = await ctx.server.waitForMessage('FirmwareStatusNotification', 60_000);
    steps.push({
      step: 13,
      description: 'FirmwareStatusNotification Installed',
      status: (fw4['status'] as string) === 'Installed' ? 'passed' : 'failed',
      expected: 'status = Installed',
      actual: `status = ${String(fw4['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_044_2_CS: CsTestCase = {
  id: 'TC_044_2_CS',
  name: 'Firmware Update - Download Failed',
  module: '19-firmware-management',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The firmware of a Charge Point is being updated, but downloading fails.',
  purpose: 'Check whether the Charge Point reports DownloadFailed.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'FirmwareStatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    await ctx.server.sendCommand('UpdateFirmware', {
      location: 'http://example.com/does_not_exist_firmware.bin',
      retrieveDate: new Date().toISOString(),
      retries: 0,
    });
    // Downloading (optional, may fail immediately)
    try {
      await ctx.server.waitForMessage('FirmwareStatusNotification', 30_000);
    } catch {
      /* optional */
    }
    const fw = await ctx.server.waitForMessage('FirmwareStatusNotification', 60_000);
    steps.push({
      step: 5,
      description: 'FirmwareStatusNotification DownloadFailed',
      status: (fw['status'] as string) === 'DownloadFailed' ? 'passed' : 'failed',
      expected: 'status = DownloadFailed',
      actual: `status = ${String(fw['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_044_3_CS: CsTestCase = {
  id: 'TC_044_3_CS',
  name: 'Firmware Update - Installation Failed',
  module: '19-firmware-management',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The firmware of a Charge Point is being updated, but installation fails.',
  purpose: 'Check whether the Charge Point reports InstallationFailed.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(async (action) => {
      if (action === 'BootNotification')
        return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
      if (action === 'StatusNotification') return {};
      if (action === 'FirmwareStatusNotification') return {};
      if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
      return {};
    });
    await ctx.server.sendCommand('UpdateFirmware', {
      location: 'http://example.com/invalid_firmware.bin',
      retrieveDate: new Date().toISOString(),
    });
    const fw1 = await ctx.server.waitForMessage('FirmwareStatusNotification', 60_000);
    steps.push({
      step: 3,
      description: 'FirmwareStatusNotification Downloading',
      status: (fw1['status'] as string) === 'Downloading' ? 'passed' : 'failed',
      expected: 'status = Downloading',
      actual: `status = ${String(fw1['status'])}`,
    });
    const fw2 = await ctx.server.waitForMessage('FirmwareStatusNotification', 60_000);
    steps.push({
      step: 5,
      description: 'FirmwareStatusNotification Downloaded',
      status: (fw2['status'] as string) === 'Downloaded' ? 'passed' : 'failed',
      expected: 'status = Downloaded',
      actual: `status = ${String(fw2['status'])}`,
    });
    const fw3 = await ctx.server.waitForMessage('FirmwareStatusNotification', 60_000);
    steps.push({
      step: 11,
      description: 'FirmwareStatusNotification InstallationFailed',
      status: (fw3['status'] as string) === 'InstallationFailed' ? 'passed' : 'failed',
      expected: 'status = InstallationFailed',
      actual: `status = ${String(fw3['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
