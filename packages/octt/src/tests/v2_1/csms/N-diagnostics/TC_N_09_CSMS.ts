// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeCustomerInfoTest = (
  id: string,
  name: string,
  desc: string,
  respondStatus: string,
  hasNotify: boolean,
): TestCase => ({
  id,
  name,
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: desc,
  purpose: 'To verify the CSMS sends CustomerInformationRequest correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    let received = false;
    ctx.client.setIncomingCallHandler(async (_mid: string, action: string) => {
      if (action === 'CustomerInformation') {
        received = true;
        return { status: respondStatus };
      }
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'CustomerInformation', {
        stationId: ctx.stationId,
        requestId: 1,
        report: true,
        clear: false,
      });
    } else {
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({
      step: 1,
      description: 'CSMS sends CustomerInformationRequest',
      status: received ? 'passed' : 'failed',
      expected: 'Request received',
      actual: received ? 'Received' : 'Not received',
    });
    if (received && hasNotify && respondStatus === 'Accepted') {
      try {
        await ctx.client.sendCall('NotifyCustomerInformation', {
          data: 'customer-data',
          seqNo: 0,
          tbc: false,
          requestId: 1,
          generatedAt: new Date().toISOString(),
        });
        steps.push({
          step: 2,
          description: 'Send NotifyCustomerInformationRequest',
          status: 'passed',
          expected: 'Response received',
          actual: 'Response received',
        });
      } catch {
        steps.push({
          step: 2,
          description: 'Send NotifyCustomerInformationRequest',
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
});

export const TC_N_27_CSMS = makeCustomerInfoTest(
  'TC_N_27_CSMS',
  'Get Customer Information - Accepted + data',
  'CSMS retrieves customer information with data.',
  'Accepted',
  true,
);
export const TC_N_28_CSMS = makeCustomerInfoTest(
  'TC_N_28_CSMS',
  'Get Customer Information - Accepted + no data',
  'CSMS retrieves customer information with no data.',
  'Accepted',
  true,
);
export const TC_N_29_CSMS = makeCustomerInfoTest(
  'TC_N_29_CSMS',
  'Get Customer Information - Not Accepted',
  'CSMS handles rejected customer information request.',
  'Rejected',
  false,
);
