// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

export const TC_R_107_CSMS: TestCase = {
  id: 'TC_R_107_CSMS',
  name: 'Configure DER control settings at CS',
  module: 'R-der-control',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'Setting DER controls, rebooting, and retrieving configured DER controls.',
  purpose: 'To check if the CSMS is able to set, get, and clear DER Controls.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let clearCount = 0;
    let setCount = 0;
    let getCount = 0;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'ClearDERControl') {
        clearCount++;
        return { status: 'Accepted' };
      }
      if (action === 'SetDERControl') {
        setCount++;
        return { status: 'Accepted' };
      }
      if (action === 'GetDERControl') {
        getCount++;
        return { status: 'Accepted' };
      }
      return {};
    });

    if (ctx.triggerCommand != null) {
      // Step 1: Clear existing DER controls
      await ctx.triggerCommand('v21', 'ClearDERControl', {
        stationId: ctx.stationId,
        isDefault: true,
      });

      // Step 2: Set a DER control
      await ctx.triggerCommand('v21', 'SetDERControl', {
        stationId: ctx.stationId,
        isDefault: true,
        controlType: 'EnterService',
        controlId: 'enterservice_1',
        enterService: {
          priority: 1,
          highVoltage: 250,
          lowVoltage: 210,
          highFreq: 50.5,
          lowFreq: 49.5,
        },
      });

      // Step 3: Get DER controls
      await ctx.triggerCommand('v21', 'GetDERControl', {
        stationId: ctx.stationId,
        requestId: 1,
        isDefault: true,
      });

      // Wait for commands to be delivered
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      await new Promise((r) => setTimeout(r, 10000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends ClearDERControlRequest(s)',
      status: clearCount > 0 ? 'passed' : 'failed',
      expected: 'At least 1 clear',
      actual: `${String(clearCount)} clear(s)`,
    });
    steps.push({
      step: 2,
      description: 'CSMS sends SetDERControlRequest(s)',
      status: setCount > 0 ? 'passed' : 'failed',
      expected: 'At least 1 set',
      actual: `${String(setCount)} set(s)`,
    });
    steps.push({
      step: 3,
      description: 'CSMS sends GetDERControlRequest(s)',
      status: getCount > 0 ? 'passed' : 'failed',
      expected: 'At least 1 get',
      actual: `${String(getCount)} get(s)`,
    });
    if (getCount > 0) {
      try {
        await ctx.client.sendCall('ReportDERControl', {
          requestId: 1,
          seqNo: 0,
          tbc: false,
          enterService: [
            {
              id: 'enterservice_1',
              enterService: {
                priority: 1,
                highVoltage: 250,
                lowVoltage: 210,
                highFreq: 50.5,
                lowFreq: 49.5,
              },
            },
          ],
        });
        steps.push({
          step: 4,
          description: 'Send ReportDERControlRequest',
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: 4,
          description: 'Send ReportDERControlRequest',
          status: 'failed',
          expected: 'Response received',
          actual: 'Error',
        });
      }
      try {
        await ctx.client.sendCall('NotifyDERStartStop', {
          controlId: 'test-ctrl-1',
          started: true,
          timestamp: new Date().toISOString(),
        });
        steps.push({
          step: 5,
          description: 'Send NotifyDERStartStopRequest',
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: 5,
          description: 'Send NotifyDERStartStopRequest',
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
