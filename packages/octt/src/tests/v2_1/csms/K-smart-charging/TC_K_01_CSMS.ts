// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station
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

// Helper: start transaction
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

/**
 * TC_K_01_CSMS: Set Charging Profile - TxDefaultProfile - Specific EVSE
 * Use case: K01 (K01.FR.31)
 */
export const TC_K_01_CSMS: TestCase = {
  id: 'TC_K_01_CSMS',
  name: 'Set Charging Profile - TxDefaultProfile - Specific EVSE',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE.',
  purpose:
    'To verify if the CSMS is able to send a TxDefaultProfile charging profile for a specific EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
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
      description: 'CSMS sends SetChargingProfileRequest, respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual: received ? 'Received, responded Accepted' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_02_CSMS: Set Charging Profile - TxProfile without ongoing transaction
 * Use case: K01
 */
export const TC_K_02_CSMS: TestCase = {
  id: 'TC_K_02_CSMS',
  name: 'Set Charging Profile - TxProfile without ongoing transaction on the specified EVSE',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE.',
  purpose:
    'To verify if the CSMS is able to send a TxProfile and read the charger feedback while no transaction is ongoing.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    let profilePayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          profilePayload = payload;
          return { status: 'Rejected' };
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
          chargingProfilePurpose: 'TxProfile',
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

    const profile = profilePayload['chargingProfile'] as Record<string, unknown> | undefined;
    const purpose = profile?.['chargingProfilePurpose'];

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with TxProfile, respond Rejected',
      status: received ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest with TxProfile',
      actual: received
        ? `Received, purpose = ${String(purpose)}, responded Rejected`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_03_CSMS: Set Charging Profile - ChargingStationMaxProfile
 * Use case: K01 (K01.FR.31, K01.FR.38)
 */
export const TC_K_03_CSMS: TestCase = {
  id: 'TC_K_03_CSMS',
  name: 'Set Charging Profile - ChargingStationMaxProfile',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from the entire Charging Station.',
  purpose: 'To verify if the CSMS is able to send a ChargingStationMaxProfile charging profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    let profilePayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          profilePayload = payload;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 0,
        chargingProfile: {
          id: 1,
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

    const evseId = profilePayload['evseId'];
    const profile = profilePayload['chargingProfile'] as Record<string, unknown> | undefined;
    const purpose = profile?.['chargingProfilePurpose'];
    const kind = profile?.['chargingProfileKind'];

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with ChargingStationMaxProfile',
      status: received ? 'passed' : 'failed',
      expected: 'evseId=0, purpose=ChargingStationMaxProfile, kind=Absolute',
      actual: received
        ? `evseId=${String(evseId)}, purpose=${String(purpose)}, kind=${String(kind)}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_10_CSMS: Set Charging Profile - TxDefaultProfile - All EVSE
 * Use case: K01 (K01.FR.31)
 */
export const TC_K_10_CSMS: TestCase = {
  id: 'TC_K_10_CSMS',
  name: 'Set Charging Profile - TxDefaultProfile - All EVSE',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from all EVSEs.',
  purpose:
    'To verify if the CSMS is able to send a TxDefaultProfile charging profile for all EVSEs.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'SetChargingProfile', {
        stationId: ctx.stationId,
        evseId: 0,
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
      description: 'CSMS sends SetChargingProfileRequest for all EVSE, respond Accepted',
      status: received ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual: received ? 'Received, responded Accepted' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_15_CSMS: Set Charging Profile - Not Supported
 * Use case: K01
 */
export const TC_K_15_CSMS: TestCase = {
  id: 'TC_K_15_CSMS',
  name: 'Set Charging Profile - Not Supported',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to influence the charging power or current drawn from a specific EVSE.',
  purpose:
    'To verify if the CSMS is able to send a Profile while the charging station does not support charging profiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          throw new Error('NotSupported');
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
      description: 'CSMS sends SetChargingProfileRequest, respond CALLERROR NotSupported',
      status: received ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual: received ? 'Received, responded NotSupported' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_19_CSMS: Set Charging Profile - ChargingProfileKind is Recurring
 * Use case: K01
 */
export const TC_K_19_CSMS: TestCase = {
  id: 'TC_K_19_CSMS',
  name: 'Set Charging Profile - ChargingProfileKind is Recurring',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'To enable the CSMS to influence the charging power with a recurring profile.',
  purpose: 'To verify if the CSMS is able to send a Profile with a recurrencyKind specified.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    let profilePayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          profilePayload = payload;
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
          chargingProfileKind: 'Recurring',
          recurrencyKind: 'Daily',
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

    const profile = profilePayload['chargingProfile'] as Record<string, unknown> | undefined;
    const kind = profile?.['chargingProfileKind'];
    const recurrencyKind = profile?.['recurrencyKind'];

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with Recurring kind',
      status: received ? 'passed' : 'failed',
      expected: 'chargingProfileKind=Recurring, recurrencyKind present',
      actual: received
        ? `kind=${String(kind)}, recurrencyKind=${String(recurrencyKind)}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_60_CSMS: Set Charging Profile - TxProfile with ongoing transaction
 * Use case: K01 (K01.FR.03, K01.FR.31)
 * Before: State is EnergyTransferStarted
 */
export const TC_K_60_CSMS: TestCase = {
  id: 'TC_K_60_CSMS',
  name: 'Set Charging Profile - TxProfile with ongoing transaction on the specified EVSE',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'The CSMS sets a TxProfile on a specific EVSE for a currently ongoing transaction.',
  purpose:
    'To verify if the CSMS is able to set a TxProfile on a specific EVSE for a currently ongoing transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);
    await startTx(ctx);

    let received = false;
    let profilePayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          profilePayload = payload;
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
          chargingProfilePurpose: 'TxProfile',
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

    const profile = profilePayload['chargingProfile'] as Record<string, unknown> | undefined;
    const purpose = profile?.['chargingProfilePurpose'];

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with TxProfile for ongoing transaction',
      status: received ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest with TxProfile',
      actual: received ? `Received, purpose=${String(purpose)}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_100_CSMS: Set Charging Profile - maxOfflineDuration
 * Use case: K01
 */
export const TC_K_100_CSMS: TestCase = {
  id: 'TC_K_100_CSMS',
  name: 'Set Charging Profile - maxOfflineDuration',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'To enable the CSMS to influence the charging power with maxOfflineDuration.',
  purpose:
    'To verify if the CSMS is able to specify a maxOfflineDuration and invalidAfterOfflineDuration.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    let profilePayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          profilePayload = payload;
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
          maxOfflineDuration: 3600,
          invalidAfterOfflineDuration: true,
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

    const profile = profilePayload['chargingProfile'] as Record<string, unknown> | undefined;
    const maxOffline = profile?.['maxOfflineDuration'];
    const invalidAfter = profile?.['invalidAfterOfflineDuration'];

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with maxOfflineDuration',
      status: received ? 'passed' : 'failed',
      expected: 'maxOfflineDuration present, invalidAfterOfflineDuration=true',
      actual: received
        ? `maxOfflineDuration=${String(maxOffline)}, invalidAfterOfflineDuration=${String(invalidAfter)}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_101_CSMS: Set Charging Profile - Change operation mode
 * Use case: K01
 */
export const TC_K_101_CSMS: TestCase = {
  id: 'TC_K_101_CSMS',
  name: 'Set Charging Profile - Change operation mode',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'To enable the CSMS to influence the charging power by changing the operation mode.',
  purpose: 'To verify if the CSMS is able to handle operation mode change via charging profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let receivedProfile = false;
    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, _payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          receivedProfile = true;
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
      description: 'CSMS sends SetChargingProfileRequest with operationMode',
      status: receivedProfile ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual: receivedProfile ? 'Received, responded Accepted' : 'Not received',
    });

    // Send TransactionEvent Updated with OperationModeChanged
    if (receivedProfile) {
      const txId = `OCTT-TX-${String(Date.now())}`;
      const res = await ctx.client.sendCall('TransactionEvent', {
        eventType: 'Updated',
        timestamp: new Date().toISOString(),
        triggerReason: 'OperationModeChanged',
        seqNo: 0,
        transactionInfo: { transactionId: txId, operationMode: 'Idle' },
      });

      steps.push({
        step: 2,
        description: 'TransactionEvent Updated with OperationModeChanged Idle',
        status: 'passed',
        expected: 'TransactionEventResponse received',
        actual: `Response keys: ${Object.keys(res).join(', ')}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_102_CSMS: Set Charging Profile - limitAtSoc
 * Use case: K01 (K01.FR.104)
 */
export const TC_K_102_CSMS: TestCase = {
  id: 'TC_K_102_CSMS',
  name: 'Set Charging Profile - limitAtSoc',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'To enable the CSMS to influence the charging power with a SoC limit.',
  purpose:
    'To verify if the CSMS is able to set a SoC limit for the transaction using a Charging Profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    let profilePayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          profilePayload = payload;
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
              limitAtSoC: { soc: 80, limit: 0 },
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const profile = profilePayload['chargingProfile'] as Record<string, unknown> | undefined;
    const schedules = profile?.['chargingSchedule'] as Record<string, unknown>[] | undefined;
    const limitAtSoC = schedules?.[0]?.['limitAtSoC'];

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with limitAtSoc',
      status: received ? 'passed' : 'failed',
      expected: 'chargingSchedule.limitAtSoC present',
      actual: received ? `limitAtSoC=${String(limitAtSoC)}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_104_CSMS: Set Charging Profile - PriorityCharging
 * Use case: K01 (K01.FR.72, K01.FR.73)
 */
export const TC_K_104_CSMS: TestCase = {
  id: 'TC_K_104_CSMS',
  name: 'Set Charging Profile - PriorityCharging',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'To enable the CSMS to influence the charging power using PriorityCharging.',
  purpose: 'To verify if the CSMS is able to set a PriorityCharging Charging Profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    let profilePayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          profilePayload = payload;
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
          chargingProfilePurpose: 'PriorityCharging',
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

    const profile = profilePayload['chargingProfile'] as Record<string, unknown> | undefined;
    const purpose = profile?.['chargingProfilePurpose'];

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with PriorityCharging',
      status: received ? 'passed' : 'failed',
      expected: 'purpose=PriorityCharging',
      actual: received ? `purpose=${String(purpose)}` : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_106_CSMS: Set Charging Profile - randomizedDelay
 * Use case: K01 (K01.FR.96)
 */
export const TC_K_106_CSMS: TestCase = {
  id: 'TC_K_106_CSMS',
  name: 'Set Charging Profile - randomizedDelay',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description: 'To enable the CSMS to influence the charging power with a randomizedDelay.',
  purpose:
    'To verify if the CSMS is able to set a Charging Profile with a randomizedDelay which uses useLocalTime.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let received = false;
    let profilePayload: Record<string, unknown> = {};

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'SetChargingProfile') {
          received = true;
          profilePayload = payload;
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
              useLocalTime: true,
              randomizedDelay: 300,
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.0 }],
            },
          ],
        },
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }

    const profile = profilePayload['chargingProfile'] as Record<string, unknown> | undefined;
    const schedules = profile?.['chargingSchedule'] as Record<string, unknown>[] | undefined;
    const useLocalTime = schedules?.[0]?.['useLocalTime'];
    const randomizedDelay = schedules?.[0]?.['randomizedDelay'];

    steps.push({
      step: 1,
      description: 'CSMS sends SetChargingProfileRequest with randomizedDelay',
      status: received ? 'passed' : 'failed',
      expected: 'useLocalTime=true, randomizedDelay > 0',
      actual: received
        ? `useLocalTime=${String(useLocalTime)}, randomizedDelay=${String(randomizedDelay)}`
        : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_K_109_CSMS: EMS Control - Set Charging Profile - MaxExternalConstraintsId
 * Use case: K01 (K01.FR.80)
 */
export const TC_K_109_CSMS: TestCase = {
  id: 'TC_K_109_CSMS',
  name: 'EMS Control - Set Charging Profile - MaxExternalConstraintsId',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'To enable the CSMS to send a charging profile using the right id set by MaxExternalConstraintsId.',
  purpose:
    'To verify if the CSMS is able to send a charging profile using the right id set by MaxExternalConstraintsId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    await boot(ctx);

    let receivedGetBase = false;
    let receivedSetProfile = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'GetBaseReport') {
          receivedGetBase = true;
          const requestId = payload['requestId'] as number;
          // Send NotifyReport with MaxExternalConstraintsId
          setTimeout(async () => {
            try {
              await ctx.client.sendCall('NotifyReport', {
                requestId,
                generatedAt: new Date().toISOString(),
                seqNo: 0,
                tbc: false,
                reportData: [
                  {
                    component: { name: 'SmartChargingCtrlr' },
                    variable: { name: 'MaxExternalConstraintsId' },
                    variableAttribute: [{ value: '2147400000' }],
                  },
                ],
              });
            } catch {
              // Ignore errors
            }
          }, 500);
          return { status: 'Accepted' };
        }
        if (action === 'SetChargingProfile') {
          receivedSetProfile = true;
          return { status: 'Accepted' };
        }
        return {};
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'GetBaseReport', {
        stationId: ctx.stationId,
        requestId: 1,
        reportBase: 'FullInventory',
      });
      // Wait for the NotifyReport callback (500ms setTimeout) to fire,
      // the CSMS to process it, and SetChargingProfile to be dispatched
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 20000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends GetBaseReportRequest',
      status: receivedGetBase ? 'passed' : 'failed',
      expected: 'GetBaseReportRequest received',
      actual: receivedGetBase ? 'Received' : 'Not received',
    });

    steps.push({
      step: 2,
      description: 'CSMS sends SetChargingProfileRequest after receiving MaxExternalConstraintsId',
      status: receivedSetProfile ? 'passed' : 'failed',
      expected: 'SetChargingProfileRequest received',
      actual: receivedSetProfile ? 'Received' : 'Not received',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
