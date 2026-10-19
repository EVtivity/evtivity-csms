// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase, TestContext, TestResult } from '../../../../types.js';
import { newTransactionId } from '../../../../csms-test-helpers.js';
import { defaultReply } from '../../../../default-replies.js';

/**
 * TC_K_57_CSMS: Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV
 * Use case: K17 (K17.FR.02, K17.FR.03, K17.FR.05, K17.FR.07, K17.FR.11)
 */
export const TC_K_57_CSMS: TestCase = {
  id: 'TC_K_57_CSMS',
  name: 'Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The EV signals the Charging Station that it wants to renegotiate and provides new charging needs.',
  purpose: 'To verify if the CSMS is able to renegotiate when the EV signals the Charging Station.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await ctx.client.sendCall('BootNotification', {
      chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
      reason: 'PowerUp',
    });
    await ctx.client.sendCall('StatusNotification', {
      timestamp: new Date().toISOString(),
      connectorStatus: 'Available',
      evseId: 1,
      connectorId: 1,
    });

    const txId = newTransactionId('OCTT-TX');
    await ctx.client.sendCall('TransactionEvent', {
      eventType: 'Started',
      timestamp: new Date().toISOString(),
      triggerReason: 'Authorized',
      seqNo: 0,
      transactionInfo: { transactionId: txId, chargingState: 'Charging' },
      evse: { id: 1, connectorId: 1 },
      idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
    });

    // Step 1-2: Send NotifyEVChargingNeeds (EV-initiated renegotiation)
    const needsRes = await ctx.client.sendCall('NotifyEVChargingNeeds', {
      evseId: 1,
      maxScheduleTuples: 3,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_three_phase',
        acChargingParameters: {
          energyAmount: 5000,
          evMinCurrent: 6,
          evMaxCurrent: 32,
          evMaxVoltage: 230,
        },
      },
    });
    const needsStatus = needsRes['status'];
    steps.push({
      step: 2,
      description: 'CSMS responds to NotifyEVChargingNeedsRequest (EV-initiated)',
      status:
        typeof needsStatus === 'string' && RENEGOTIATION_NEEDS_STATUSES.includes(needsStatus)
          ? 'passed'
          : 'failed',
      expected: `status = ${RENEGOTIATION_NEEDS_STATUSES.join(' or ')}`,
      actual: `status = ${String(needsStatus)}`,
    });

    // Step 3-4: the test triggers the TxProfile through the CSMS command route and checks
    // the SetChargingProfileRequest that reaches the station.
    let received: Record<string, unknown> | null = null;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = payload;
          return { status: 'Accepted' };
        }
        return defaultReply(ctx.version, action, payload);
      },
    );
    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          transactionId: txId,
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const request = received as Record<string, unknown> | null;
    const profile = (request?.['chargingProfile'] ?? {}) as Record<string, unknown>;
    const evseId = request?.['evseId'];
    const purpose = profile['chargingProfilePurpose'];
    const profileTxId = profile['transactionId'];
    const profileValid =
      request != null && evseId === 1 && purpose === 'TxProfile' && profileTxId === txId;
    steps.push({
      step: 3,
      description: 'CSMS sends SetChargingProfileRequest with a TxProfile for the transaction',
      status: profileValid ? 'passed' : 'failed',
      expected: `evseId = 1, chargingProfilePurpose = TxProfile, transactionId = ${txId}`,
      actual:
        request == null
          ? 'No SetChargingProfileRequest received'
          : `evseId = ${String(evseId)}, chargingProfilePurpose = ${String(purpose)}, transactionId = ${String(profileTxId)}`,
    });

    // Step 5-6: NotifyEVChargingSchedule with the schedule provided at step 3.
    if (request != null) {
      const schedules = profile['chargingSchedule'];
      const schedule = Array.isArray(schedules) ? (schedules[0] as unknown) : undefined;
      const schedRes = await ctx.client.sendCall('NotifyEVChargingSchedule', {
        timeBase: new Date().toISOString(),
        evseId: 1,
        chargingSchedule: schedule ?? {
          id: 1,
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
        },
      });
      steps.push({
        step: 6,
        description: 'CSMS responds to NotifyEVChargingScheduleRequest',
        status: (schedRes['status'] as string) === 'Accepted' ? 'passed' : 'failed',
        expected: 'status = Accepted',
        actual: `status = ${String(schedRes['status'])}`,
      });
    }

    return {
      status: steps.length > 0 && steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/** TC_K_57, TC_K_114 and TC_K_115 step 2 allow only these NotifyEVChargingNeedsResponse statuses. */
const RENEGOTIATION_NEEDS_STATUSES = ['Accepted', 'Processing'];

function listSize(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function profileOf(request: Record<string, unknown>): Record<string, unknown> {
  return (request['chargingProfile'] ?? {}) as Record<string, unknown>;
}

/** Step 3 of TC_K_114 and TC_K_115: a TxProfile on EVSE 1 for the running transaction. */
function txProfileChecks(
  request: Record<string, unknown>,
  txId: string,
): { failures: string[]; observed: string } {
  const profile = profileOf(request);
  const evseId = request['evseId'];
  const purpose = profile['chargingProfilePurpose'];
  const profileTxId = profile['transactionId'];
  const failures: string[] = [];
  if (evseId !== 1) failures.push('evseId');
  if (purpose !== 'TxProfile') failures.push('chargingProfilePurpose');
  if (profileTxId !== txId) failures.push('transactionId');
  return {
    failures,
    observed: `evseId = ${String(evseId)}, chargingProfilePurpose = ${String(purpose)}, transactionId = ${String(profileTxId)}`,
  };
}

function firstSchedule(request: Record<string, unknown>): unknown {
  const schedules = profileOf(request)['chargingSchedule'];
  return Array.isArray(schedules) ? (schedules[0] as unknown) : undefined;
}

/**
 * Starts the transaction, sends the charging needs (steps 1-2), triggers the
 * CSMS TxProfile and returns the SetChargingProfileRequest it sent (steps 3-4).
 */
async function renegotiate(
  ctx: TestContext,
  steps: StepResult[],
  options: {
    chargingState: string;
    maxScheduleTuples: number;
    chargingNeeds: Record<string, unknown>;
    limitW: number;
  },
): Promise<{ txId: string; request: Record<string, unknown> | null }> {
  await ctx.client.sendCall('BootNotification', {
    chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
    reason: 'PowerUp',
  });
  await ctx.client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Available',
    evseId: 1,
    connectorId: 1,
  });

  const txId = newTransactionId('OCTT-TX');
  await ctx.client.sendCall('TransactionEvent', {
    eventType: 'Started',
    timestamp: new Date().toISOString(),
    triggerReason: 'Authorized',
    seqNo: 0,
    transactionInfo: { transactionId: txId, chargingState: options.chargingState },
    evse: { id: 1, connectorId: 1 },
    idToken: { idToken: ctx.tokens.valid, type: 'ISO14443' },
  });

  const needsRes = await ctx.client.sendCall('NotifyEVChargingNeeds', {
    evseId: 1,
    maxScheduleTuples: options.maxScheduleTuples,
    chargingNeeds: options.chargingNeeds,
  });
  const needsStatus = needsRes['status'];
  steps.push({
    step: 2,
    description: 'CSMS responds to NotifyEVChargingNeedsRequest',
    status:
      typeof needsStatus === 'string' && RENEGOTIATION_NEEDS_STATUSES.includes(needsStatus)
        ? 'passed'
        : 'failed',
    expected: `status = ${RENEGOTIATION_NEEDS_STATUSES.join(' or ')}`,
    actual: `status = ${String(needsStatus)}`,
  });

  let received: Record<string, unknown> | null = null;
  ctx.client.setIncomingCallHandler(
    async (_messageId: string, action: string, payload: Record<string, unknown>) => {
      if (action === 'SetChargingProfile') {
        received = payload;
        return { status: 'Accepted' };
      }
      return defaultReply(ctx.version, action, payload);
    },
  );
  if (ctx.triggerCommand != null) {
    await ctx.triggerCommand('v21', 'SetChargingProfile', {
      stationId: ctx.stationId,
      evseId: 1,
      chargingProfile: {
        id: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        transactionId: txId,
        chargingSchedule: [
          {
            id: 1,
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [{ startPeriod: 0, limit: options.limitW }],
          },
        ],
      },
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  return { txId, request: received as Record<string, unknown> | null };
}

/** Steps 5-6: NotifyEVChargingSchedule with the schedule the CSMS provided at step 3. */
async function notifySchedule(
  ctx: TestContext,
  steps: StepResult[],
  request: Record<string, unknown>,
): Promise<void> {
  const schedule = firstSchedule(request);
  if (schedule == null) {
    steps.push({
      step: 6,
      description: 'CSMS responds to NotifyEVChargingScheduleRequest',
      status: 'failed',
      expected: 'status = Accepted',
      actual: 'No chargingSchedule from step 3 to send',
    });
    return;
  }
  const schedRes = await ctx.client.sendCall('NotifyEVChargingSchedule', {
    timeBase: new Date().toISOString(),
    evseId: 1,
    chargingSchedule: schedule,
  });
  steps.push({
    step: 6,
    description: 'CSMS responds to NotifyEVChargingScheduleRequest',
    status: schedRes['status'] === 'Accepted' ? 'passed' : 'failed',
    expected: 'status = Accepted',
    actual: `status = ${String(schedRes['status'])}`,
  });
}

function caseResult(steps: StepResult[]): TestResult {
  return {
    status: steps.length > 0 && steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
    durationMs: 0,
    steps,
  };
}

const STEP3_DESCRIPTION =
  'CSMS sends SetChargingProfileRequest with a TxProfile for the transaction';

/**
 * TC_K_114_CSMS: Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV (v2x)
 * Use case: K17 (K17.FR.02, K17.FR.03, K17.FR.05, K17.FR.07, K17.FR.08, K17.FR.11)
 */
export const TC_K_114_CSMS: TestCase = {
  id: 'TC_K_114_CSMS',
  name: 'Renegotiating a Charging Schedule ISO 15118-20 - Initiated by EV (v2x)',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The EV signals renegotiation with ISO 15118-20 v2x charging parameters.',
  purpose: 'To verify if the CSMS handles EV-initiated renegotiation with v2x parameters.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const { txId, request } = await renegotiate(ctx, steps, {
      chargingState: 'Charging',
      maxScheduleTuples: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_three_phase',
        availableEnergyTransfer: ['AC_single_phase', 'AC_three_phase', 'AC_BPT'],
        controlMode: 'ScheduledControl',
        v2xChargingParameters: { maxChargePower: 6000, maxDischargePower: 0 },
      },
      limitW: 6000.0,
    });

    const expected = `evseId = 1, chargingProfilePurpose = TxProfile, transactionId = ${txId}, chargingSchedule size = 1`;
    if (request == null) {
      steps.push({
        step: 3,
        description: STEP3_DESCRIPTION,
        status: 'failed',
        expected,
        actual: 'No SetChargingProfileRequest received',
      });
      return caseResult(steps);
    }
    const { failures, observed } = txProfileChecks(request, txId);
    const scheduleCount = listSize(profileOf(request)['chargingSchedule']);
    if (scheduleCount !== 1) failures.push('chargingSchedule size');
    steps.push({
      step: 3,
      description: STEP3_DESCRIPTION,
      status: failures.length === 0 ? 'passed' : 'failed',
      expected,
      actual: `${observed}, chargingSchedule size = ${String(scheduleCount)}`,
    });

    await notifySchedule(ctx, steps, request);
    return caseResult(steps);
  },
};

/** maxScheduleTuples of the TC_K_115 charging needs, the most entries each schedule list may hold. */
const K115_MAX_SCHEDULE_TUPLES = 3;

/**
 * TC_K_115_CSMS: ISO 15118-20 Dynamic Control Mode - Success
 * Use case: K17, K19 (K17.FR.19, K19.FR.02, K19.FR.03, K19.FR.05, K19.FR.07, K19.FR.08)
 */
export const TC_K_115_CSMS: TestCase = {
  id: 'TC_K_115_CSMS',
  name: 'ISO 15118-20 Dynamic Control Mode - Success',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The EV signals renegotiation with DynamicControl mode via ISO 15118-20.',
  purpose: 'To verify if the CSMS handles Dynamic Control mode with BPT.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    const max = K115_MAX_SCHEDULE_TUPLES;
    const { txId, request } = await renegotiate(ctx, steps, {
      chargingState: 'EVConnected',
      maxScheduleTuples: max,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_BPT',
        availableEnergyTransfer: ['AC_single_phase', 'AC_three_phase', 'AC_BPT'],
        controlMode: 'DynamicControl',
        v2xChargingParameters: { maxChargePower: 5000, maxDischargePower: 5000 },
      },
      limitW: 5000.0,
    });

    const expected =
      `evseId = 1, chargingProfilePurpose = TxProfile, transactionId = ${txId}, each chargingSchedule ` +
      `with at most ${String(max)} chargingSchedulePeriod, absolutePriceSchedule.priceRuleStacks ` +
      `and priceLevelSchedule.priceLevelScheduleEntries`;
    if (request == null) {
      steps.push({
        step: 3,
        description: STEP3_DESCRIPTION,
        status: 'failed',
        expected,
        actual: 'No SetChargingProfileRequest received',
      });
      return caseResult(steps);
    }
    const { failures, observed } = txProfileChecks(request, txId);
    const rawSchedules = profileOf(request)['chargingSchedule'];
    const schedules = Array.isArray(rawSchedules)
      ? (rawSchedules as Record<string, unknown>[])
      : [];
    if (schedules.length === 0) failures.push('chargingSchedule');
    const sizes = schedules.map((schedule) => {
      const price = (schedule['absolutePriceSchedule'] ?? {}) as Record<string, unknown>;
      const level = (schedule['priceLevelSchedule'] ?? {}) as Record<string, unknown>;
      return [
        listSize(schedule['chargingSchedulePeriod']),
        listSize(price['priceRuleStacks']),
        listSize(level['priceLevelScheduleEntries']),
      ] as const;
    });
    if (sizes.some(([periods]) => periods > max)) failures.push('chargingSchedulePeriod size');
    if (sizes.some(([, stacks]) => stacks > max)) failures.push('priceRuleStacks size');
    if (sizes.some(([, , entries]) => entries > max)) {
      failures.push('priceLevelScheduleEntries size');
    }
    const sizeText =
      sizes.length === 0
        ? 'no chargingSchedule'
        : sizes
            .map(
              ([periods, stacks, entries]) =>
                `chargingSchedulePeriod ${String(periods)}, priceRuleStacks ${String(stacks)}, priceLevelScheduleEntries ${String(entries)}`,
            )
            .join('; ');
    steps.push({
      step: 3,
      description: STEP3_DESCRIPTION,
      status: failures.length === 0 ? 'passed' : 'failed',
      expected,
      actual: `${observed}, ${sizeText}`,
    });

    await notifySchedule(ctx, steps, request);
    return caseResult(steps);
  },
};
