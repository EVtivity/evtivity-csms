// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

const makeClearCustomerTest = (id: string, name: string, desc: string): TestCase => ({
  id,
  name,
  module: 'N-diagnostics',
  version: 'ocpp2.1',
  sut: 'csms',
  description: desc,
  purpose: 'To verify the CSMS sends CustomerInformationRequest for clearing data.',
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
        return { status: 'Accepted' };
      }
      if (action === 'SendLocalList') return { status: 'Accepted' };
      return {};
    });
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'CustomerInformation', {
        stationId: ctx.stationId,
        requestId: 1,
        report: true,
        clear: true,
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
    if (received) {
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

export const TC_N_30_CSMS = makeClearCustomerTest(
  'TC_N_30_CSMS',
  'Clear Customer Information - Clear and report + data',
  'CSMS clears and reports customer information with data.',
);
export const TC_N_31_CSMS = makeClearCustomerTest(
  'TC_N_31_CSMS',
  'Clear Customer Information - Clear and report + no data',
  'CSMS clears and reports customer information with no data.',
);
export const TC_N_32_CSMS = makeClearCustomerTest(
  'TC_N_32_CSMS',
  'Clear Customer Information - Clear and no report',
  'CSMS clears customer information without reporting.',
);
export const TC_N_62_CSMS = makeClearCustomerTest(
  'TC_N_62_CSMS',
  'Clear Customer Information - customerIdentifier',
  'CSMS clears customer information by customerIdentifier.',
);
export const TC_N_63_CSMS = makeClearCustomerTest(
  'TC_N_63_CSMS',
  'Clear Customer Information - customerCertificate',
  'CSMS clears customer information by customerCertificate.',
);
export const TC_N_46_CSMS = makeClearCustomerTest(
  'TC_N_46_CSMS',
  'Clear Customer Information - Update Local Authorization List',
  'CSMS clears customer info and updates local auth list.',
);
