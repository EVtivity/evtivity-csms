// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import type { TestResult } from '../../../../types.js';
import {
  setVariables,
  waitForChargingState,
  waitForTriggerReason,
} from '../../../../cs-test-helpers.js';

/**
 * TC_B_102_CS / TC_B_103_CS: Reset ImmediateAndResume with an ongoing
 * transaction. The transaction survives the reboot and is resumed with
 * TxResumed; energy transfer resumes only when AllowEnergyTransferResumption.
 */
async function resetAndResume(ctx: CsTestContext, allowEnergy: boolean): Promise<TestResult> {
  const steps: StepResult[] = [];
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    return {};
  });

  // Configuration State
  const notAccepted = await setVariables(ctx.server, [
    { component: 'TxCtrlr', variable: 'ResumptionTimeout', value: '999' },
    {
      component: 'TxCtrlr',
      variable: 'AllowEnergyTransferResumption',
      value: allowEnergy ? 'true' : 'false',
    },
  ]);
  steps.push({
    step: 0,
    description: 'Before: Configuration State (SetVariablesRequest)',
    status: notAccepted.length === 0 ? 'passed' : 'failed',
    expected: 'All variables Accepted',
    actual: notAccepted.length === 0 ? 'All Accepted' : notAccepted.join(', '),
  });

  // Reusable State EnergyTransferStarted
  await ctx.station.plugIn(1);
  await ctx.station.authorize(1, 'OCTT-TOKEN-001');
  const charging = await waitForChargingState(ctx.server, 'Charging', 10_000);
  const txId = (charging?.['transactionInfo'] as Record<string, unknown> | undefined)?.[
    'transactionId'
  ] as string | undefined;
  steps.push({
    step: 0,
    description: 'Before: Reusable State EnergyTransferStarted',
    status: txId != null ? 'passed' : 'failed',
    expected: 'TransactionEventRequest with chargingState Charging',
    actual: txId != null ? `transactionId ${txId}` : 'not received',
  });
  if (txId == null) return { status: 'failed', durationMs: 0, steps };

  // Step 1: Reusable State Booted with reset type ImmediateAndResume
  ctx.server.clearBuffer();
  const reset = await ctx.server.sendCommand('Reset', { type: 'ImmediateAndResume' });
  steps.push({
    step: 1,
    description: 'Booted: ResetResponse status Accepted',
    status: reset['status'] === 'Accepted' ? 'passed' : 'failed',
    expected: 'status Accepted',
    actual: `status ${String(reset['status'])}`,
  });
  let boot: Record<string, unknown> | null = null;
  try {
    boot = await ctx.server.waitForMessage('BootNotification', 15_000);
  } catch {
    boot = null;
  }
  steps.push({
    step: 1,
    description: 'Booted: Charging Station sends BootNotificationRequest',
    status: boot != null ? 'passed' : 'failed',
    expected: 'BootNotificationRequest',
    actual: boot != null ? `reason ${String(boot['reason'])}` : 'not received',
  });
  let security: Record<string, unknown> | null = null;
  try {
    security = await ctx.server.waitForMessage('SecurityEventNotification', 10_000);
  } catch {
    security = null;
  }
  const securityType = security?.['type'] as string | undefined;
  steps.push({
    step: 1,
    description: 'Booted: SecurityEventNotificationRequest StartupOfTheDevice or ResetOrReboot',
    status:
      securityType === 'StartupOfTheDevice' || securityType === 'ResetOrReboot'
        ? 'passed'
        : 'failed',
    expected: 'type StartupOfTheDevice or ResetOrReboot',
    actual: `type ${String(securityType)}`,
  });

  // Step 2 (optional CablePluggedIn) and step 4: TransactionEventRequest TxResumed
  const resumed = await waitForTriggerReason(ctx.server, 'TxResumed', 15_000);
  const info = resumed?.['transactionInfo'] as Record<string, unknown> | undefined;
  const expectedState = allowEnergy ? 'Charging' : 'SuspendedEVSE';
  steps.push({
    step: 4,
    description: `TransactionEventRequest Updated, TxResumed, chargingState ${expectedState}, same transactionId`,
    status:
      resumed?.['eventType'] === 'Updated' &&
      info?.['chargingState'] === expectedState &&
      info['transactionId'] === txId
        ? 'passed'
        : 'failed',
    expected: `eventType Updated, chargingState ${expectedState}, transactionId ${txId}`,
    actual:
      resumed == null
        ? 'TxResumed not received'
        : `eventType ${String(resumed['eventType'])}, chargingState ${String(info?.['chargingState'])}, transactionId ${String(info?.['transactionId'])}`,
  });

  const allPassed = steps.every((s) => s.status === 'passed');
  return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
}

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
  execute: async (ctx) => resetAndResume(ctx, false),
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
  execute: async (ctx) => resetAndResume(ctx, true),
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
