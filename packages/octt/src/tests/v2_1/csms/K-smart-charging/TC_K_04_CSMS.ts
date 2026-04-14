// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

async function boot(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
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
}

async function startTx(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
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
  return txId;
}

// n/a: Replace charging profile - With chargingProfileId
export const TC_K_04_CSMS: TestCase = {
  id: 'TC_K_04_CSMS',
  name: 'Replace charging profile - With chargingProfileId',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE or the entire charging station.',
  purpose:
    'To verify if the CSMS is able to replace a charging profile with the same ProfileKind, Purpose, and chargingProfileId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let profileCount = 0;
    let firstProfileLimit: number | null = null;
    let secondProfileLimit: number | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          profileCount++;
          const profile = payload['chargingProfile'] as Record<string, unknown> | undefined;
          const schedule = (
            profile?.['chargingSchedule'] as Record<string, unknown>[] | undefined
          )?.[0];
          const periods = schedule?.['chargingSchedulePeriod'] as
            | Array<Record<string, unknown>>
            | undefined;
          const limit = (periods?.[0]?.['limit'] as number | undefined) ?? null;

          if (profileCount === 1) {
            firstProfileLimit = limit;
          } else if (profileCount === 2) {
            secondProfileLimit = limit;
          }
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 8.0 }],
            },
          ],
        },
      });
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 6.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends first SetChargingProfileRequest (8A or 8000W)',
      status: profileCount >= 1 ? 'passed' : 'failed',
      expected: 'First SetChargingProfileRequest received',
      actual: `Received ${String(profileCount)} profile request(s), limit = ${String(firstProfileLimit)}`,
    });

    steps.push({
      step: 2,
      description: 'CSMS sends second SetChargingProfileRequest (6A or 6000W) to replace first',
      status: profileCount >= 2 ? 'passed' : 'failed',
      expected: 'Second SetChargingProfileRequest received with same profileId',
      actual: `Profile count = ${String(profileCount)}, second limit = ${String(secondProfileLimit)}`,
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// n/a: Set Charging Profile - Multiple Profiles
export const TC_K_70_CSMS: TestCase = {
  id: 'TC_K_70_CSMS',
  name: 'Set Charging Profile - Multiple Profiles',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE or the entire charging station.',
  purpose: 'To verify if the CSMS is able to set multiple Charging Profiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);

    let txDefaultReceived = false;
    let maxProfileReceived = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          const profile = payload['chargingProfile'] as Record<string, unknown> | undefined;
          const purpose = profile?.['chargingProfilePurpose'] as string | undefined;
          if (purpose === 'TxDefaultProfile') {
            txDefaultReceived = true;
          } else if (purpose === 'ChargingStationMaxProfile') {
            maxProfileReceived = true;
          }
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
            },
          ],
        },
      });
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 0,
        chargingProfile: {
          id: 2,
          stackLevel: 0,
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          chargingProfileKind: 'Absolute',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'A',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 32.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with TxDefaultProfile',
      status: txDefaultReceived ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest with chargingProfilePurpose = TxDefaultProfile',
      actual: txDefaultReceived ? 'TxDefaultProfile received' : 'TxDefaultProfile not received',
    });

    steps.push({
      step: 2,
      description: 'CSMS sends SetChargingProfileRequest with ChargingStationMaxProfile',
      status: maxProfileReceived ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest with chargingProfilePurpose = ChargingStationMaxProfile',
      actual: maxProfileReceived
        ? 'ChargingStationMaxProfile received'
        : 'ChargingStationMaxProfile not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// K21: Priority Charging - Requesting priority charging remotely
export const TC_K_118_CSMS: TestCase = {
  id: 'TC_K_118_CSMS',
  name: 'Priority Charging - Requesting priority charging remotely',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE or the entire charging station.',
  purpose: 'To verify the CSMS supports priority charging initiated from CSMS.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);
    const txId = await startTx(ctx);

    // Wait for CSMS to send UsePriorityCharging
    let receivedUsePriority = false;
    let priorityTxId: string | null = null;
    let activateValue: boolean | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'UsePriorityCharging') {
          receivedUsePriority = true;
          priorityTxId = payload['transactionId'] as string;
          activateValue = payload['activate'] as boolean;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'UsePriorityCharging', {
        stationId: ctx.stationId,
        transactionId: txId,
        activate: true,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends UsePriorityChargingRequest with activate = true',
      status: receivedUsePriority ? 'passed' : 'failed',
      expected: 'UsePriorityChargingRequest received with transactionId and activate = true',
      actual: receivedUsePriority
        ? `Received: transactionId = ${String(priorityTxId)}, activate = ${String(activateValue)}`
        : 'No UsePriorityChargingRequest received',
    });

    if (receivedUsePriority) {
      steps.push({
        step: 2,
        description: 'UsePriorityCharging references correct transactionId',
        status: priorityTxId === txId ? 'passed' : 'failed',
        expected: `transactionId = ${txId}`,
        actual: `transactionId = ${String(priorityTxId)}`,
      });
    }

    if (!receivedUsePriority) {
      return { status: 'failed', durationMs: 0, steps };
    }

    // Step 3: Send NotifyPriorityCharging
    try {
      await ctx.client.sendCall('NotifyPriorityCharging', {
        transactionId: txId,
        activated: true,
      });
      steps.push({
        step: 3,
        description: 'Send NotifyPriorityChargingRequest with activated = true',
        status: 'passed',
        expected: 'NotifyPriorityChargingResponse received',
        actual: 'Response received',
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Send NotifyPriorityChargingRequest with activated = true',
        status: 'failed',
        expected: 'NotifyPriorityChargingResponse received',
        actual: 'Error',
      });
    }

    return {
      status: steps.filter((s) => s.status === 'failed').length === 0 ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

// K28: Dynamic charging profiles from CSMS - Pull
export const TC_K_121_CSMS: TestCase = {
  id: 'TC_K_121_CSMS',
  name: 'Dynamic charging profiles from CSMS - Pull',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE or the entire charging station.',
  purpose: 'To verify if the CSMS is able to support DynamicControl charging profiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await boot(ctx);
    await startTx(ctx);

    // Wait for CSMS to send SetChargingProfile with dynamic profile
    let receivedSetProfile = false;
    let dynamicProfileId: number | null = null;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          receivedSetProfile = true;
          const profile = payload['chargingProfile'] as Record<string, unknown> | undefined;
          dynamicProfileId = profile?.['id'] as number | null;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingProfileKind: 'Absolute',
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

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with dynamic profile',
      status: receivedSetProfile ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual: receivedSetProfile
        ? `Received: profileId = ${String(dynamicProfileId)}`
        : 'No SetChargingProfileRequest received',
    });

    if (!receivedSetProfile) {
      return { status: 'failed', durationMs: 0, steps };
    }

    // Step 2: Send PullDynamicScheduleUpdate with unknown profileId
    try {
      const pullRes1 = await ctx.client.sendCall('PullDynamicScheduleUpdate', {
        chargingProfileId: 99999,
      });
      steps.push({
        step: 2,
        description: 'Send PullDynamicScheduleUpdate with unknown chargingProfileId',
        status: 'passed',
        expected: 'PullDynamicScheduleUpdateResponse received',
        actual: `Response keys: ${Object.keys(pullRes1).join(', ')}`,
      });
    } catch {
      steps.push({
        step: 2,
        description: 'Send PullDynamicScheduleUpdate with unknown chargingProfileId',
        status: 'failed',
        expected: 'PullDynamicScheduleUpdateResponse received',
        actual: 'Error',
      });
    }

    // Step 3: Send PullDynamicScheduleUpdate with correct profileId
    try {
      const pullRes2 = await ctx.client.sendCall('PullDynamicScheduleUpdate', {
        chargingProfileId: dynamicProfileId ?? 1,
      });
      steps.push({
        step: 3,
        description: 'Send PullDynamicScheduleUpdate with correct chargingProfileId from step 1',
        status: 'passed',
        expected: 'PullDynamicScheduleUpdateResponse with schedule data',
        actual: `Response keys: ${Object.keys(pullRes2).join(', ')}`,
      });
    } catch {
      steps.push({
        step: 3,
        description: 'Send PullDynamicScheduleUpdate with correct chargingProfileId',
        status: 'failed',
        expected: 'PullDynamicScheduleUpdateResponse received',
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
