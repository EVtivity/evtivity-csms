// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_P_01_CS: CsTestCase = {
  id: 'TC_P_01_CS',
  name: 'Data Transfer to CS - Rejected / Unknown VendorId / Unknown MessageId',
  module: 'P-data-transfer',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS sends a DataTransferRequest with an unknown vendor and message ID.',
  purpose:
    'To verify whether the Charging Station handles a DataTransferRequest it does not support.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const res = await ctx.server.sendCommand('DataTransfer', {
      vendorId: 'org.openchargealliance.TestSystem',
      messageId: 'UnknownMessage',
    });
    const status = res['status'] as string;
    const valid = ['UnknownVendorId', 'UnknownMessageId', 'Rejected'].includes(status);
    steps.push({
      step: 1,
      description: 'DataTransferResponse with UnknownVendorId, UnknownMessageId, or Rejected',
      status: valid ? 'passed' : 'failed',
      expected: 'status = UnknownVendorId OR UnknownMessageId OR Rejected',
      actual: `status = ${status}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
