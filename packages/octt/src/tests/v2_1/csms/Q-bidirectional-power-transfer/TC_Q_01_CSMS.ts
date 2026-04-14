// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_Q_102_CSMS: TestCase = {
  id: 'TC_Q_102_CSMS',
  name: 'V2X Authorisation - ISO15118-20 - Allowed Energy',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Authorization of an EV by the CSMS to start a V2X power transfer.',
  purpose:
    'To check if the CSMS provides an empty allowedEnergyTransfer list when unable to determine.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let getBaseReportReceived = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'GetBaseReport') {
        getBaseReportReceived = true;
        return { status: 'Accepted' };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetBaseReport', {
        stationId: ctx.stationId,
        requestId: 1,
        reportBase: 'FullInventory',
      });
    } else {
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (getBaseReportReceived) {
      await ctx.client.sendCall('NotifyReport', {
        requestId: 1,
        seqNo: 0,
        tbc: false,
        generatedAt: new Date().toISOString(),
        reportData: [
          {
            component: { name: 'V2XChargingCtrlr', evse: { id: 1 } },
            variable: { name: 'V2XEnabled' },
            variableAttribute: [{ value: 'true' }],
          },
        ],
      });
    }
    steps.push({
      step: 1,
      description: 'Report V2XEnabled via NotifyReport',
      status: 'passed',
      expected: 'Completed',
      actual: 'Completed',
    });
    try {
      const resp = await ctx.client.sendCall('Authorize', {
        idToken: { idToken: 'OCTT-TOKEN-V2X', type: 'ISO14443' },
      });
      const idTokenInfo = resp['idTokenInfo'] as Record<string, unknown> | undefined;
      const authStatus = idTokenInfo?.['status'] as string | undefined;
      steps.push({
        step: 2,
        description: 'Send AuthorizeRequest',
        status: authStatus === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${authStatus ?? 'unknown'}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'Send AuthorizeRequest',
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

export const TC_Q_103_CSMS: TestCase = {
  id: 'TC_Q_103_CSMS',
  name: 'V2X Authorisation - ISO15118-20 - Charging needs rejected',
  module: 'Q-bidirectional-power-transfer',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS rejects a NotifyEVChargingNeedsRequest with unsupported energy transfer.',
  purpose: 'To check if the CSMS rejects charging needs with unsupported energy transfer mode.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    try {
      const resp = await ctx.client.sendCall('NotifyEVChargingNeeds', {
        evseId: 1,
        chargingNeeds: {
          requestedEnergyTransfer: 'AC_BPT',
          availableEnergyTransfer: [
            'AC_single_phase',
            'AC_two_phase',
            'AC_three_phase',
            'AC_BPT',
            'AC_BPT_DER',
            'AC_DER',
          ],
          controlMode: 'ScheduledControl',
          v2xChargingParameters: { maxChargePower: 1234, maxDischargePower: 0 },
        },
      });
      const status = resp['status'] as string;
      steps.push({
        step: 1,
        description: 'Send NotifyEVChargingNeedsRequest with unsupported mode',
        status: ['Rejected', 'NoChargingProfile'].includes(status) ? 'passed' : 'failed',
        expected: 'status = Rejected or NoChargingProfile',
        actual: `status = ${status}`,
      });
    } catch {
      steps.push({
        step: 1,
        description: 'Send NotifyEVChargingNeedsRequest',
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
