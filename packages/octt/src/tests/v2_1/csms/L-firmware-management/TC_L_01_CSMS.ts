// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';
import { pushSendAckStep } from '../../../../csms-test-helpers.js';

// L01: Secure Firmware Update - Installation successful
export const TC_L_01_CSMS: TestCase = {
  id: 'TC_L_01_CSMS',
  name: 'Secure Firmware Update - Installation successful',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS requests the Charging Station to securely download and install a new firmware.',
  purpose:
    'To verify if the CSMS is able to request the Charging Station to securely download and install a new firmware.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Boot the station
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;
    let updateFirmwarePayload: Record<string, unknown> | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'UpdateFirmware') {
          receivedUpdateFirmware = true;
          updateFirmwarePayload = payload;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'UpdateFirmwareRequest received' : 'No request received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    // Step 2: Send firmware status notifications through the update lifecycle
    const statuses = [
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'Installing',
      'InstallRebooting',
    ];

    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        const resp82 = await ctx.client.sendCall('FirmwareStatusNotification', {
          status: fwStatus,
          requestId:
            (updateFirmwarePayload as unknown as Record<string, unknown>)?.['requestId'] ?? 1,
        });
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: resp82 != null ? 'passed' : 'failed',
          expected: 'Response received',
          actual: resp82 != null ? 'Response received' : 'No response',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error or rejection',
        });
      }
    }

    // Step 7: Send BootNotification with reason FirmwareUpdate
    try {
      const bootResp = await ctx.client.sendCall('BootNotification', {
        chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT', firmwareVersion: '2.0.0' },
        reason: 'FirmwareUpdate',
      });
      const bootStatus = bootResp['status'] as string;
      steps.push({
        step: 7,
        description: 'Send BootNotification with reason FirmwareUpdate',
        status: bootStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${bootStatus}`,
      });
    } catch {
      steps.push({
        step: 7,
        description: 'Send BootNotification with reason FirmwareUpdate',
        status: 'failed',
        expected: 'status = Accepted',
        actual: 'Error sending BootNotification',
      });
    }

    // Step 8: Send StatusNotification Available
    try {
      const resp8 = await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 1,
        connectorId: 1,
      });
      pushSendAckStep(steps, 8, 'Send StatusNotification Available after reboot', resp8);
    } catch {
      steps.push({
        step: 8,
        description: 'Send StatusNotification Available after reboot',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Step 9: Send final FirmwareStatusNotification Installed
    try {
      const resp9 = await ctx.client.sendCall('FirmwareStatusNotification', {
        status: 'Installed',
        requestId:
          (updateFirmwarePayload as unknown as Record<string, unknown>)?.['requestId'] ?? 1,
      });
      pushSendAckStep(steps, 9, 'Send FirmwareStatusNotification with status Installed', resp9);
    } catch {
      steps.push({
        step: 9,
        description: 'Send FirmwareStatusNotification with status Installed',
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

// L01: Secure Firmware Update - InstallScheduled
export const TC_L_02_CSMS: TestCase = {
  id: 'TC_L_02_CSMS',
  name: 'Secure Firmware Update - InstallScheduled',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS requests the Charging Station to securely download a new firmware and schedule installation.',
  purpose:
    'To verify the CSMS handles a scheduled firmware installation with InstallScheduled status.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        receivedUpdateFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = [
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'InstallScheduled',
      'Installing',
      'InstallRebooting',
    ];

    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        const resp249 = await ctx.client.sendCall('FirmwareStatusNotification', {
          status: fwStatus,
        });
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: resp249 != null ? 'passed' : 'failed',
          expected: 'Response received',
          actual: resp249 != null ? 'Response received' : 'No response',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }

    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT', firmwareVersion: '2.0.0' },
      reason: 'FirmwareUpdate',
    });
    steps.push({
      step: 8,
      description: 'Send BootNotification with reason FirmwareUpdate after reboot',
      status: (bootResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${bootResp['status'] as string}`,
    });

    const resp9 = await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Installed' });
    pushSendAckStep(steps, 9, 'Send FirmwareStatusNotification Installed', resp9);

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// L01: Secure Firmware Update - DownloadScheduled
export const TC_L_03_CSMS: TestCase = {
  id: 'TC_L_03_CSMS',
  name: 'Secure Firmware Update - DownloadScheduled',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS requests the Charging Station to schedule securely downloading a new firmware.',
  purpose: 'To verify the CSMS handles DownloadScheduled firmware status.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        receivedUpdateFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = [
      'DownloadScheduled',
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'Installing',
      'InstallRebooting',
    ];

    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        const resp363 = await ctx.client.sendCall('FirmwareStatusNotification', {
          status: fwStatus,
        });
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: resp363 != null ? 'passed' : 'failed',
          expected: 'Response received',
          actual: resp363 != null ? 'Response received' : 'No response',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }

    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT', firmwareVersion: '2.0.0' },
      reason: 'FirmwareUpdate',
    });
    steps.push({
      step: 8,
      description: 'Send BootNotification with reason FirmwareUpdate',
      status: (bootResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${bootResp['status'] as string}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// L01: Secure Firmware Update - RevokedCertificate
export const TC_L_04_CSMS: TestCase = {
  id: 'TC_L_04_CSMS',
  name: 'Secure Firmware Update - RevokedCertificate',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS handles a Charging Station reporting the firmware signing certificate is revoked.',
  purpose: 'To verify the CSMS handles RevokedCertificate response to UpdateFirmwareRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        receivedUpdateFirmware = true;
        return { status: 'RevokedCertificate' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'Respond with status RevokedCertificate',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'Response sent with RevokedCertificate',
      actual: receivedUpdateFirmware ? 'Sent' : 'Not sent',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// L01: Secure Firmware Update - InvalidCertificate
export const TC_L_05_CSMS: TestCase = {
  id: 'TC_L_05_CSMS',
  name: 'Secure Firmware Update - InvalidCertificate',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS handles a Charging Station reporting the firmware signing certificate is invalid.',
  purpose: 'To verify the CSMS handles InvalidCertificate response to UpdateFirmwareRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        receivedUpdateFirmware = true;
        return { status: 'InvalidCertificate' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest, respond with InvalidCertificate',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// L01: Secure Firmware Update - InvalidSignature
export const TC_L_06_CSMS: TestCase = {
  id: 'TC_L_06_CSMS',
  name: 'Secure Firmware Update - InvalidSignature',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS handles a Charging Station reporting the firmware signature is invalid.',
  purpose: 'To verify the CSMS handles InvalidSignature firmware status notification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        receivedUpdateFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = ['Downloading', 'Downloaded', 'InvalidSignature'];
    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        const resp581 = await ctx.client.sendCall('FirmwareStatusNotification', {
          status: fwStatus,
        });
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: resp581 != null ? 'passed' : 'failed',
          expected: 'Response received',
          actual: resp581 != null ? 'Response received' : 'No response',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }

    // Send SecurityEventNotification
    try {
      const resp5 = await ctx.client.sendCall('SecurityEventNotification', {
        type: 'InvalidFirmwareSignature',
        timestamp: new Date().toISOString(),
      });
      pushSendAckStep(steps, 5, 'Send SecurityEventNotification InvalidFirmwareSignature', resp5);
    } catch {
      steps.push({
        step: 5,
        description: 'Send SecurityEventNotification InvalidFirmwareSignature',
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

// L01: Secure Firmware Update - DownloadFailed
export const TC_L_07_CSMS: TestCase = {
  id: 'TC_L_07_CSMS',
  name: 'Secure Firmware Update - DownloadFailed',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS handles a Charging Station reporting it failed to download the firmware.',
  purpose: 'To verify the CSMS handles DownloadFailed firmware status notification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        receivedUpdateFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = ['Downloading', 'DownloadFailed'];
    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        const resp688 = await ctx.client.sendCall('FirmwareStatusNotification', {
          status: fwStatus,
        });
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: resp688 != null ? 'passed' : 'failed',
          expected: 'Response received',
          actual: resp688 != null ? 'Response received' : 'No response',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
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

// L01: Secure Firmware Update - InstallVerificationFailed
export const TC_L_08_CSMS: TestCase = {
  id: 'TC_L_08_CSMS',
  name: 'Secure Firmware Update - InstallVerificationFailed',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS handles a Charging Station reporting the verification of the firmware failed.',
  purpose: 'To verify the CSMS handles InstallVerificationFailed firmware status notification.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        receivedUpdateFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const statuses = [
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'Installing',
      'InstallVerificationFailed',
    ];
    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        const resp779 = await ctx.client.sendCall('FirmwareStatusNotification', {
          status: fwStatus,
        });
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: resp779 != null ? 'passed' : 'failed',
          expected: 'Response received',
          actual: resp779 != null ? 'Response received' : 'No response',
        });
      } catch {
        steps.push({
          step: i + 2,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
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

// L01: Secure Firmware Update - InstallationFailed
export const TC_L_09_CSMS: TestCase = {
  id: 'TC_L_09_CSMS',
  name: 'Secure Firmware Update - InstallationFailed',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS handles a Charging Station reporting the installation of the firmware failed.',
  purpose: 'To verify the CSMS handles InstallationFailed firmware status after reboot.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        receivedUpdateFirmware = true;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    const preRebootStatuses = [
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'Installing',
      'InstallRebooting',
    ];
    for (let i = 0; i < preRebootStatuses.length; i++) {
      const fwStatus = preRebootStatuses[i];
      if (fwStatus == null) continue;
      await ctx.client.sendCall('FirmwareStatusNotification', { status: fwStatus });
    }

    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'FirmwareUpdate',
    });
    steps.push({
      step: 2,
      description: 'Send BootNotification after reboot',
      status: (bootResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${bootResp['status'] as string}`,
    });

    try {
      const resp3 = await ctx.client.sendCall('FirmwareStatusNotification', {
        status: 'InstallationFailed',
      });
      pushSendAckStep(steps, 3, 'Send FirmwareStatusNotification InstallationFailed', resp3);
    } catch {
      steps.push({
        step: 3,
        description: 'Send FirmwareStatusNotification InstallationFailed',
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

// L01: Secure Firmware Update - AcceptedCanceled
export const TC_L_10_CSMS: TestCase = {
  id: 'TC_L_10_CSMS',
  name: 'Secure Firmware Update - AcceptedCanceled',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS handles a Charging Station reporting an ongoing installation of a firmware update that is canceled.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station reporting InstallationFailed after a failed update attempt.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let receivedUpdateFirmware = false;
    let requestId: number | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'UpdateFirmware') {
          receivedUpdateFirmware = true;
          requestId = payload['requestId'] as number | null;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    // Send FirmwareStatusNotification with InstallationFailed
    try {
      const resp2 = await ctx.client.sendCall('FirmwareStatusNotification', {
        status: 'InstallationFailed',
        requestId: requestId ?? 1,
      });
      pushSendAckStep(
        steps,
        2,
        'Send FirmwareStatusNotification with status InstallationFailed',
        resp2,
        'FirmwareStatusNotificationResponse received',
      );
    } catch {
      steps.push({
        step: 2,
        description: 'Send FirmwareStatusNotification with status InstallationFailed',
        status: 'failed',
        expected: 'FirmwareStatusNotificationResponse received',
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

// L01: Secure Firmware Update - Unable to cancel
export const TC_L_11_CSMS: TestCase = {
  id: 'TC_L_11_CSMS',
  name: 'Secure Firmware Update - Unable to cancel',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS handles a Charging Station reporting the ongoing installation of a firmware cannot be cancelled.',
  purpose: 'To verify the CSMS handles a Rejected response to a second UpdateFirmwareRequest.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    let updateCount = 0;

    ctx.client.setIncomingCallHandler(async (_messageId: string, action: string) => {
      if (action === 'UpdateFirmware') {
        updateCount++;
        if (updateCount === 1) return { status: 'Accepted' };
        return { status: 'Rejected' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends first UpdateFirmwareRequest',
      status: updateCount >= 1 ? 'passed' : 'failed',
      expected: 'First UpdateFirmwareRequest received',
      actual: `Received ${String(updateCount)} request(s)`,
    });

    if (updateCount < 1) {
      return { status: 'failed', durationMs: 0, steps };
    }

    await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Downloading' });

    // Wait for second UpdateFirmware (cancel attempt)
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 2,
        firmware: {
          location: 'https://example.com/fw-cancel.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Continue with installation
    const statuses = ['Downloaded', 'SignatureVerified', 'Installing', 'InstallRebooting'];
    for (const fwStatus of statuses) {
      await ctx.client.sendCall('FirmwareStatusNotification', { status: fwStatus });
    }

    const bootResp = await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT', firmwareVersion: '2.0.0' },
      reason: 'FirmwareUpdate',
    });
    steps.push({
      step: 2,
      description: 'Send BootNotification after firmware update',
      status: (bootResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${bootResp['status'] as string}`,
    });

    const resp3 = await ctx.client.sendCall('FirmwareStatusNotification', { status: 'Installed' });
    pushSendAckStep(steps, 3, 'Send FirmwareStatusNotification Installed', resp3);

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// L01: Secure Firmware Update - Unable to download/install firmware with ongoing transaction
export const TC_L_13_CSMS: TestCase = {
  id: 'TC_L_13_CSMS',
  name: 'Secure Firmware Update - Unable to download/install firmware with ongoing transaction',
  module: 'L-firmware-management',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS requests firmware update while a transaction is ongoing. Station sets non-transaction connectors to Unavailable, waits for transaction to end, then downloads and installs.',
  purpose:
    'To verify if the CSMS is able to handle a Charging Station setting connectors to Unavailable while preparing for a firmware update with an ongoing transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });

    // Start a transaction
    const txId = `OCTT-TX-${String(Date.now())}`;
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
    });

    // Wait for UpdateFirmware from CSMS
    let receivedUpdateFirmware = false;
    let requestId: number | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'UpdateFirmware') {
          receivedUpdateFirmware = true;
          requestId = payload['requestId'] as number | null;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UpdateFirmware', {
        stationId: ctx.stationId,
        requestId: 1,
        firmware: {
          location: 'https://example.com/fw.bin',
          retrieveDateTime: new Date().toISOString(),
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UpdateFirmwareRequest while transaction is ongoing',
      status: receivedUpdateFirmware ? 'passed' : 'failed',
      expected: 'UpdateFirmwareRequest received',
      actual: receivedUpdateFirmware ? 'Received' : 'Not received',
    });

    if (!receivedUpdateFirmware) {
      return { status: 'failed', durationMs: 0, steps };
    }

    // Send DownloadScheduled status
    try {
      const resp2 = await ctx.client.sendCall('FirmwareStatusNotification', {
        status: 'DownloadScheduled',
        requestId: requestId ?? 1,
      });
      pushSendAckStep(
        steps,
        2,
        'Send FirmwareStatusNotification with status DownloadScheduled',
        resp2,
      );
    } catch {
      steps.push({
        step: 2,
        description: 'Send FirmwareStatusNotification with status DownloadScheduled',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // Send StatusNotification Unavailable for connector without transaction
    try {
      const resp3 = await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Unavailable',
        evseId: 2,
        connectorId: 1,
      });
      pushSendAckStep(
        steps,
        3,
        'Send StatusNotification Unavailable for non-transaction connector',
        resp3,
      );
    } catch {
      steps.push({
        step: 3,
        description: 'Send StatusNotification Unavailable for non-transaction connector',
        status: 'failed',
        expected: 'Response received',
        actual: 'Error',
      });
    }

    // End the ongoing transaction
    try {
      const resp4 = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Ended',
        timestamp: new Date().toISOString(),
        triggerReason: 'StopAuthorized',
        seqNo: 1,
        transactionInfo: { transactionId: txId, stoppedReason: 'Local' },
      });
      pushSendAckStep(
        steps,
        4,
        'End the ongoing transaction (StopAuthorized)',
        resp4,
        'TransactionEventResponse received',
      );
    } catch {
      steps.push({
        step: 4,
        description: 'End the ongoing transaction',
        status: 'failed',
        expected: 'TransactionEventResponse received',
        actual: 'Error',
      });
    }

    // Send firmware update status progression
    const statuses = [
      'Downloading',
      'Downloaded',
      'SignatureVerified',
      'Installing',
      'InstallRebooting',
    ];

    for (let i = 0; i < statuses.length; i++) {
      const fwStatus = statuses[i];
      if (fwStatus == null) continue;
      try {
        const resp1266 = await ctx.client.sendCall('FirmwareStatusNotification', {
          status: fwStatus,
          requestId: requestId ?? 1,
        });
        steps.push({
          step: 5 + i,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: resp1266 != null ? 'passed' : 'failed',
          expected: 'Response received',
          actual: resp1266 != null ? 'Response received' : 'No response',
        });
      } catch {
        steps.push({
          step: 5 + i,
          description: `Send FirmwareStatusNotification with status ${fwStatus}`,
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
    }

    // BootNotification after reboot
    try {
      const bootResp = await ctx.client.sendCall('BootNotification', {
        chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT', firmwareVersion: '2.0.0' },
        reason: 'FirmwareUpdate',
      });
      const bootStatus = bootResp['status'] as string;
      steps.push({
        step: 10,
        description: 'Send BootNotification with reason FirmwareUpdate after reboot',
        status: bootStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${bootStatus}`,
      });
    } catch {
      steps.push({
        step: 10,
        description: 'Send BootNotification after reboot',
        status: 'failed',
        expected: 'status = Accepted',
        actual: 'Error',
      });
    }

    // Send Available status after reboot
    try {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 1,
        connectorId: 1,
      });
    } catch {
      // non-critical
    }

    // Final Installed status
    try {
      const resp11 = await ctx.client.sendCall('FirmwareStatusNotification', {
        status: 'Installed',
        requestId: requestId ?? 1,
      });
      pushSendAckStep(steps, 11, 'Send FirmwareStatusNotification with status Installed', resp11);
    } catch {
      steps.push({
        step: 11,
        description: 'Send FirmwareStatusNotification with status Installed',
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
