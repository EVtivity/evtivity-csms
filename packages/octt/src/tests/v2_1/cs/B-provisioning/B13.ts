// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

export const TC_B_101_CS: CsTestCase = {
  id: 'TC_B_101_CS',
  name: 'Reset ImmediateAndResume - With Ongoing Transaction - TxResumptionTimeout 0',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS can remotely request the Charging Station to reset itself by sending a ResetRequest during a transaction.',
  purpose:
    'To verify if the Charging Station is able to reject a ResetRequest with type ImmediateAndResume when TxResumptionTimeout is 0.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Before: TxCtrlr.ResumptionTimeout = 0 (default in CSS)
    const resetRes = await ctx.server.sendCommand('Reset', { type: 'ImmediateAndResume' });
    const resetStatus = resetRes['status'] as string;
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Rejected',
      status: resetStatus === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${resetStatus}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_B_102_CS: CsTestCase = {
  id: 'TC_B_102_CS',
  name: 'Reset ImmediateAndResume - With ongoing transaction - Energy Transfer Suspended',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset itself with an ongoing transaction that resumes with suspended energy transfer.',
  purpose:
    'To verify if the Charging Station is able to perform the reset mechanism while there is an ongoing transaction and resume with SuspendedEVSE.',
  execute: async (_ctx) => {
    // Requires CSS transaction resumption after reboot (TxResumed trigger).
    // CSS does not yet support persisting and resuming transactions across reboots.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_B_103_CS: CsTestCase = {
  id: 'TC_B_103_CS',
  name: 'Reset ImmediateAndResume - With Ongoing Transaction - Resuming Energy Transfer',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset itself with an ongoing transaction that resumes energy transfer.',
  purpose:
    'To verify if the Charging Station is able to perform the reset mechanism while there is an ongoing transaction and resume with Charging.',
  execute: async (_ctx) => {
    // Requires CSS transaction resumption after reboot (TxResumed trigger).
    // CSS does not yet support persisting and resuming transactions across reboots.
    return { status: 'skipped', durationMs: 0, steps: [] };
  },
};

export const TC_B_104_CS: CsTestCase = {
  id: 'TC_B_104_CS',
  name: 'Reset ImmediateAndResume - Without ongoing transaction',
  module: 'B-provisioning',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'This test case covers how the CSMS can remotely request the Charging Station to reset itself with ImmediateAndResume but no ongoing transaction.',
  purpose:
    'To verify if the Charging Station is able to perform the reset mechanism without an ongoing transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    // Before: Set ResumptionTimeout > 0 so ImmediateAndResume is accepted
    await ctx.server.sendCommand('SetVariables', {
      setVariableData: [
        {
          component: { name: 'TxCtrlr' },
          variable: { name: 'ResumptionTimeout' },
          attributeValue: '300',
        },
      ],
    });

    const resetRes = await ctx.server.sendCommand('Reset', { type: 'ImmediateAndResume' });
    steps.push({
      step: 2,
      description: 'ResetResponse: status = Accepted',
      status: (resetRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${resetRes['status'] as string}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
