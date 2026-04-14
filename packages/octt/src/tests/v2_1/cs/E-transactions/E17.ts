// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import {
  waitForChargingState,
  waitForTriggerReason,
  waitForTransactionEventType,
} from '../../../../cs-test-helpers.js';

function setupHandler(ctx: {
  server: {
    setMessageHandler: (
      h: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
  };
}) {
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'NotifyEvent') return {};
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    if (action === 'TransactionEvent') return {};
    if (action === 'SecurityEventNotification') return {};
    return {};
  });
}

/**
 * Start a transaction and reach Charging state. Returns the transactionId.
 * After this, sets the resume config values and triggers power cycle.
 */
async function startTransactionAndPowerCycle(
  ctx: CsTestContext,
  resumptionTimeout: string | null,
  allowEnergyResumption: boolean,
): Promise<void> {
  // Start charging
  await ctx.station.plugIn(1);
  await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
  await waitForChargingState(ctx.server, 'Charging', 10_000);

  // Configure resumption settings
  if (resumptionTimeout != null) {
    ctx.station.setConfigValue('TxCtrlr.ResumptionTimeout', resumptionTimeout);
  } else {
    // Absent: delete the config key entirely
    ctx.station.deleteConfigValue('TxCtrlr.ResumptionTimeout');
  }
  ctx.station.setConfigValue(
    'TxCtrlr.AllowEnergyTransferResumption',
    allowEnergyResumption ? 'true' : 'false',
  );

  // Clear buffer before power cycle so we only see reconnect messages
  ctx.server.clearBuffer();

  // Simulate power loss preserving transaction state
  await ctx.station.simulatePowerCyclePreserveTransactions();
}

export const TC_E_112_CS: CsTestCase = {
  id: 'TC_E_112_CS',
  name: 'Resuming transaction after interruption - TxResumptionTimeout not expired - AllowEnergyTransferResumption false',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging station is able to restore running transactions after a reboot.',
  purpose:
    'To verify whether the Charging Station was able to resume transactions after a reboot without energy transfer resumption.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // TxCtrlr.ResumptionTimeout=999 (not expired), AllowEnergyTransferResumption=false
    await startTransactionAndPowerCycle(ctx, '999', false);

    // Step 1: BootNotificationRequest after reconnect
    const bootMsg = await ctx.server.waitForMessage('BootNotification', 15000);
    steps.push({
      step: 1,
      description: 'BootNotificationRequest after power restore',
      status: bootMsg ? 'passed' : 'failed',
      expected: 'BootNotificationRequest received',
      actual: bootMsg ? 'Received' : 'Timeout',
    });

    // Step 3: StatusNotification for connectors (Occupied for active EVSE)
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    const statusPayload = statusMsg as Record<string, unknown> | null;
    const evseId = statusPayload?.['evseId'] as number | undefined;
    steps.push({
      step: 3,
      description: 'StatusNotification for connectors (Occupied for active EVSE)',
      status: evseId !== undefined && evseId !== 0 ? 'passed' : 'failed',
      expected: 'StatusNotification with evseId not 0',
      actual: `evseId=${evseId}`,
    });

    // Step 5: SecurityEventNotification (optional)
    let secEvtReceived = false;
    try {
      const secEvt = await ctx.server.waitForMessage('SecurityEventNotification', 5000);
      if (secEvt) secEvtReceived = true;
    } catch {
      secEvtReceived = false;
    }
    steps.push({
      step: 5,
      description: 'SecurityEventNotificationRequest (optional)',
      status: 'passed',
      expected: 'SecurityEventNotification (optional)',
      actual: secEvtReceived ? 'Received' : 'Not received (optional)',
    });

    // Step 13: TransactionEvent Updated with TxResumed, chargingState SuspendedEVSE
    // Skip MeterValuePeriodic events from before power cycle
    const txMsg = await waitForTriggerReason(ctx.server, 'TxResumed', 10000);
    const evtType = txMsg?.['eventType'] as string | undefined;
    const txInfo = txMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState = txInfo?.['chargingState'] as string | undefined;

    steps.push({
      step: 13,
      description: 'TransactionEvent Updated TxResumed SuspendedEVSE',
      status:
        txMsg != null && evtType === 'Updated' && chState === 'SuspendedEVSE' ? 'passed' : 'failed',
      expected: 'eventType Updated, triggerReason TxResumed, chargingState SuspendedEVSE',
      actual: `eventType=${evtType}, triggerReason=${txMsg?.['triggerReason'] as string | undefined}, chargingState=${chState}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_113_CS: CsTestCase = {
  id: 'TC_E_113_CS',
  name: 'Resuming transaction after interruption - TxResumptionTimeout not expired - AllowEnergyTransferResumption true',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'Charging station is able to restore running transactions after a reboot.',
  purpose:
    'To verify whether the Charging Station was able to resume transactions after a reboot with energy transfer resumption.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // TxCtrlr.ResumptionTimeout=999 (not expired), AllowEnergyTransferResumption=true
    await startTransactionAndPowerCycle(ctx, '999', true);

    // Step 1: BootNotificationRequest
    const bootMsg = await ctx.server.waitForMessage('BootNotification', 15000);
    steps.push({
      step: 1,
      description: 'BootNotificationRequest after power restore',
      status: bootMsg ? 'passed' : 'failed',
      expected: 'BootNotificationRequest received',
      actual: bootMsg ? 'Received' : 'Timeout',
    });

    // Step 3: StatusNotification for connectors
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    steps.push({
      step: 3,
      description: 'StatusNotification for connectors',
      status: statusMsg ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: statusMsg ? 'Received' : 'Timeout',
    });

    // Step 13: TransactionEvent Updated TxResumed Charging
    // Skip MeterValuePeriodic events from before power cycle
    const txMsg113 = await waitForTriggerReason(ctx.server, 'TxResumed', 10000);
    const evtType113 = txMsg113?.['eventType'] as string | undefined;
    const txInfo113 = txMsg113?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState113 = txInfo113?.['chargingState'] as string | undefined;

    steps.push({
      step: 13,
      description: 'TransactionEvent Updated TxResumed Charging',
      status:
        txMsg113 != null && evtType113 === 'Updated' && chState113 === 'Charging'
          ? 'passed'
          : 'failed',
      expected: 'eventType Updated, triggerReason TxResumed, chargingState Charging',
      actual: `eventType=${evtType113}, triggerReason=${txMsg113?.['triggerReason'] as string | undefined}, chargingState=${chState113}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_114_CS: CsTestCase = {
  id: 'TC_E_114_CS',
  name: 'Resuming transaction after interruption - Powerloss - TxResumptionTimeout absent',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging station does not support resuming the transactions that were running before powerloss.',
  purpose: 'To verify whether the Charging Station does not resume the transactions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // TxCtrlr.ResumptionTimeout absent (null), no energy resumption
    await startTransactionAndPowerCycle(ctx, null, false);

    const bootMsg = await ctx.server.waitForMessage('BootNotification', 15000);
    steps.push({
      step: 1,
      description: 'BootNotificationRequest after power restore',
      status: bootMsg ? 'passed' : 'failed',
      expected: 'BootNotificationRequest received',
      actual: bootMsg ? 'Received' : 'Timeout',
    });

    // Wait for TransactionEvent and verify no TxResumed (should be Ended with AbnormalCondition)
    let trigReason: string | undefined;
    let evtType: string | undefined;
    try {
      const txMsg = await ctx.server.waitForMessage('TransactionEvent', 15000);
      const txPayload = txMsg as Record<string, unknown> | null;
      trigReason = txPayload?.['triggerReason'] as string | undefined;
      evtType = txPayload?.['eventType'] as string | undefined;
    } catch {
      trigReason = undefined;
    }

    steps.push({
      step: 2,
      description: 'No TransactionEvent with triggerReason TxResumed',
      status: trigReason !== 'TxResumed' ? 'passed' : 'failed',
      expected: 'No TxResumed trigger (may have AbnormalCondition Ended)',
      actual: trigReason
        ? `eventType=${evtType}, triggerReason=${trigReason}`
        : 'No TransactionEvent (correct if no resume support)',
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_115_CS: CsTestCase = {
  id: 'TC_E_115_CS',
  name: 'Resuming transaction after interruption - Powerloss - TxResumptionTimeout = 0',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging station is configured to not resume the transactions that were running before powerloss.',
  purpose: 'To verify whether the Charging Station does not resume the transactions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // TxCtrlr.ResumptionTimeout=0 (never resume)
    await startTransactionAndPowerCycle(ctx, '0', false);

    const bootMsg = await ctx.server.waitForMessage('BootNotification', 15000);
    steps.push({
      step: 1,
      description: 'BootNotificationRequest after power restore',
      status: bootMsg ? 'passed' : 'failed',
      expected: 'BootNotificationRequest received',
      actual: bootMsg ? 'Received' : 'Timeout',
    });

    // TransactionEvent Ended with AbnormalCondition, stoppedReason PowerLoss/Reboot
    // Skip MeterValuePeriodic events from before power cycle
    const txMsg115 = await waitForTriggerReason(ctx.server, 'AbnormalCondition', 15000);
    const evtType115 = txMsg115?.['eventType'] as string | undefined;
    const txInfo115 = txMsg115?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stoppedReason115 = txInfo115?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 2,
      description: 'TransactionEvent Ended AbnormalCondition PowerLoss/Reboot',
      status:
        txMsg115 != null &&
        evtType115 === 'Ended' &&
        (stoppedReason115 === 'PowerLoss' || stoppedReason115 === 'Reboot')
          ? 'passed'
          : 'failed',
      expected: 'eventType Ended, triggerReason AbnormalCondition, stoppedReason PowerLoss/Reboot',
      actual: `eventType=${evtType115}, triggerReason=${txMsg115?.['triggerReason'] as string | undefined}, stoppedReason=${stoppedReason115}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_E_116_CS: CsTestCase = {
  id: 'TC_E_116_CS',
  name: 'Resuming transaction after interruption - Powerloss - TxResumptionTimeout expired',
  module: 'E-transactions',
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'Charging station reports running transactions as ended after a reboot and TxResumptionTimeout occurred.',
  purpose:
    'To verify whether the Charging Station was able to end the transactions after a reboot and an expired TxResumptionTimeout.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    setupHandler(ctx);

    // TxCtrlr.ResumptionTimeout=1 (1 second, will expire during reconnect)
    // Start transaction, set short timeout, then power cycle
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT-TOKEN-001');
    await waitForChargingState(ctx.server, 'Charging', 10_000);

    ctx.station.setConfigValue('TxCtrlr.ResumptionTimeout', '1');
    ctx.station.setConfigValue('TxCtrlr.AllowEnergyTransferResumption', 'false');

    ctx.server.clearBuffer();
    await ctx.station.simulatePowerCyclePreserveTransactions();

    // Wait for the resumption timeout to expire (reconnect takes time)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Step 1: BootNotificationRequest
    const bootMsg = await ctx.server.waitForMessage('BootNotification', 15000);
    steps.push({
      step: 1,
      description: 'BootNotificationRequest after power restore',
      status: bootMsg ? 'passed' : 'failed',
      expected: 'BootNotificationRequest received',
      actual: bootMsg ? 'Received' : 'Timeout',
    });

    // Step 3: StatusNotification for connectors
    const statusMsg = await ctx.server.waitForMessage('StatusNotification', 10000);
    steps.push({
      step: 3,
      description: 'StatusNotification for connectors',
      status: statusMsg ? 'passed' : 'failed',
      expected: 'StatusNotification received',
      actual: statusMsg ? 'Received' : 'Timeout',
    });

    // Step 11: TransactionEvent Ended AbnormalCondition PowerLoss (skip MeterValuePeriodic)
    const txEndMsg = await waitForTriggerReason(ctx.server, 'AbnormalCondition', 10000);
    const evtType11 = txEndMsg?.['eventType'] as string | undefined;
    const txInfo11 = txEndMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const stoppedReason11 = txInfo11?.['stoppedReason'] as string | undefined;

    steps.push({
      step: 11,
      description: 'TransactionEvent Ended AbnormalCondition PowerLoss',
      status:
        txEndMsg != null && evtType11 === 'Ended' && stoppedReason11 === 'PowerLoss'
          ? 'passed'
          : 'failed',
      expected: 'eventType Ended, triggerReason AbnormalCondition, stoppedReason PowerLoss',
      actual: `eventType=${evtType11}, triggerReason=${txEndMsg?.['triggerReason'] as string | undefined}, stoppedReason=${stoppedReason11}`,
    });

    // Step 13: TransactionEvent Started (new transaction) with different transactionId
    const txStartMsg = await waitForTransactionEventType(ctx.server, 'Started', 10000);
    const trigReason13 = txStartMsg?.['triggerReason'] as string | undefined;
    const txInfo13 = txStartMsg?.['transactionInfo'] as Record<string, unknown> | undefined;
    const chState13 = txInfo13?.['chargingState'] as string | undefined;

    steps.push({
      step: 13,
      description: 'TransactionEvent Started (new transaction) EVConnected',
      status:
        txStartMsg != null &&
        (trigReason13 === 'CablePluggedIn' || trigReason13 === 'ChargingStateChanged') &&
        chState13 === 'EVConnected'
          ? 'passed'
          : 'failed',
      expected:
        'eventType Started, triggerReason CablePluggedIn/ChargingStateChanged, chargingState EVConnected',
      actual: `eventType=${txStartMsg?.['eventType'] as string | undefined}, triggerReason=${trigReason13}, chargingState=${chState13}`,
    });

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
