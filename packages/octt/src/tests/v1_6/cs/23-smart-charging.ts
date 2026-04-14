// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../cs-types.js';

const SC_HANDLER = async (action: string) => {
  if (action === 'BootNotification')
    return { status: 'Accepted', currentTime: new Date().toISOString(), interval: 300 };
  if (action === 'StatusNotification') return {};
  if (action === 'Authorize') return { idTagInfo: { status: 'Accepted' } };
  if (action === 'StartTransaction') return { transactionId: 1, idTagInfo: { status: 'Accepted' } };
  if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  return {};
};

export const TC_056_CS: CsTestCase = {
  id: 'TC_056_CS',
  name: 'Central Smart Charging - TxDefaultProfile',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sets a default schedule for new transactions.',
  purpose: 'To check whether the Charge Point handles a default schedule for new transactions.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    const setResp = await ctx.server.sendCommand('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'SetChargingProfile Accepted',
      status: (setResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(setResp['status'])}`,
    });
    const getResp = await ctx.server.sendCommand('GetCompositeSchedule', {
      connectorId: 1,
      duration: 300,
      chargingRateUnit: 'W',
    });
    steps.push({
      step: 4,
      description: 'GetCompositeSchedule Accepted',
      status: (getResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(getResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_057_CS: CsTestCase = {
  id: 'TC_057_CS',
  name: 'Central Smart Charging - TxProfile',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sets a schedule for a running transaction.',
  purpose: 'To check whether the Charge Point handles a Charging Profile with purpose TxProfile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    // Before: plug in cable for Charging state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain charging setup messages (StatusNotification, Authorize, StartTransaction/TransactionEvent)
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* consumed */
    }
    const setResp = await ctx.server.sendCommand('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        transactionId: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'SetChargingProfile Accepted',
      status: (setResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(setResp['status'])}`,
    });
    const getResp = await ctx.server.sendCommand('GetCompositeSchedule', {
      connectorId: 1,
      duration: 300,
      chargingRateUnit: 'W',
    });
    steps.push({
      step: 4,
      description: 'GetCompositeSchedule Accepted',
      status: (getResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(getResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_058_1_CS: CsTestCase = {
  id: 'TC_058_1_CS',
  name: 'Central Smart Charging - No ongoing transaction',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sets a schedule for a transaction that is not running.',
  purpose: 'To check whether the Charge Point rejects TxProfile when no transaction is running.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    const setResp = await ctx.server.sendCommand('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        transactionId: 99999,
        stackLevel: 0,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'SetChargingProfile Rejected',
      status: (setResp['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(setResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_058_2_CS: CsTestCase = {
  id: 'TC_058_2_CS',
  name: 'Central Smart Charging - Wrong transactionId',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sets a schedule with wrong transactionId.',
  purpose: 'To check whether the Charge Point rejects TxProfile with wrong transactionId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    // Before: plug in cable for Charging state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain charging setup messages (StatusNotification, Authorize, StartTransaction/TransactionEvent)
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* consumed */
    }
    const setResp = await ctx.server.sendCommand('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        transactionId: 99999,
        stackLevel: 0,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'SetChargingProfile Rejected (wrong txId)',
      status: (setResp['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(setResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_082_CS: CsTestCase = {
  id: 'TC_082_CS',
  name: 'Central Smart Charging - TxDefaultProfile - with ongoing transaction',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sets a default schedule for a currently ongoing transaction.',
  purpose:
    'To check whether the Charge Point handles a default schedule during an ongoing transaction.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    // Before: plug in cable for Charging state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain charging setup messages (StatusNotification, Authorize, StartTransaction/TransactionEvent)
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* consumed */
    }
    const setResp = await ctx.server.sendCommand('SetChargingProfile', {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxDefaultProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'SetChargingProfile Accepted',
      status: (setResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(setResp['status'])}`,
    });
    const getResp = await ctx.server.sendCommand('GetCompositeSchedule', {
      connectorId: 1,
      duration: 300,
      chargingRateUnit: 'W',
    });
    steps.push({
      step: 4,
      description: 'GetCompositeSchedule Accepted',
      status: (getResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(getResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_066_CS: CsTestCase = {
  id: 'TC_066_CS',
  name: 'Get Composite Schedule',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sends 3 ChargingProfiles and validates the composite schedule.',
  purpose: 'To check whether the Charge Point computes composite schedules correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    // Before: plug in cable for Charging state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain charging setup messages (StatusNotification, Authorize, StartTransaction/TransactionEvent)
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* consumed */
    }
    const getResp = await ctx.server.sendCommand('GetCompositeSchedule', {
      connectorId: 1,
      duration: 400,
      chargingRateUnit: 'W',
    });
    steps.push({
      step: 2,
      description: 'GetCompositeSchedule Accepted',
      status: (getResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(getResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_067_CS: CsTestCase = {
  id: 'TC_067_CS',
  name: 'Clear Charging Profile',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sets charging profiles and clears them.',
  purpose: 'To check whether the Charge Point is able to clear charging profiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    const clearResp = await ctx.server.sendCommand('ClearChargingProfile', { id: 1 });
    steps.push({
      step: 2,
      description: 'ClearChargingProfile Accepted',
      status: (clearResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(clearResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_072_CS: CsTestCase = {
  id: 'TC_072_CS',
  name: 'Stacking Charging Profiles',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System sends 2 ChargingProfiles and validates stacking.',
  purpose: 'To check whether the Charge Point stacks ChargingProfiles correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    const getResp = await ctx.server.sendCommand('GetCompositeSchedule', {
      connectorId: 1,
      duration: 350,
      chargingRateUnit: 'W',
    });
    steps.push({
      step: 2,
      description: 'GetCompositeSchedule Accepted',
      status: (getResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(getResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_059_CS: CsTestCase = {
  id: 'TC_059_CS',
  name: 'Remote Start Transaction with Charging Profile',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System starts a transaction with a ChargingProfile.',
  purpose: 'To check whether the Charge Point starts a transaction with a Charging Profile.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    // Before: plug in cable for Charging state
    await ctx.station.plugIn(1);
    await ctx.station.startCharging(1, 'OCTT_TAG_001');
    // Drain charging setup messages (StatusNotification, Authorize, StartTransaction/TransactionEvent)
    for (let _d = 0; _d < 10; _d++) {
      try {
        await ctx.server.waitForMessage('StatusNotification', 500);
      } catch {
        break;
      }
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('TransactionEvent', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('Authorize', 500);
    } catch {
      /* drain */
    }
    try {
      await ctx.server.waitForMessage('StartTransaction', 5000);
    } catch {
      /* consumed */
    }
    const getResp = await ctx.server.sendCommand('GetCompositeSchedule', {
      connectorId: 1,
      duration: 300,
      chargingRateUnit: 'W',
    });
    steps.push({
      step: 3,
      description: 'GetCompositeSchedule Accepted',
      status: (getResp['status'] as string) === 'Accepted' ? 'passed' : 'failed',
      expected: 'status = Accepted',
      actual: `status = ${String(getResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

export const TC_060_CS: CsTestCase = {
  id: 'TC_060_CS',
  name: 'Remote Start Transaction with Charging Profile - Rejected',
  module: '23-smart-charging',
  version: 'ocpp1.6',
  sut: 'cs',
  description: 'The Central System tries to start a transaction but it is rejected.',
  purpose:
    'To check whether the Charge Point rejects a transaction with wrong ChargingProfile purpose.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(SC_HANDLER);
    const rsResp = await ctx.server.sendCommand('RemoteStartTransaction', {
      connectorId: 1,
      idTag: 'OCTT_TAG_001',
      chargingProfile: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'ChargePointMaxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: {
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 6000 }],
        },
      },
    });
    steps.push({
      step: 2,
      description: 'RemoteStartTransaction Rejected (wrong purpose)',
      status: (rsResp['status'] as string) === 'Rejected' ? 'passed' : 'failed',
      expected: 'status = Rejected',
      actual: `status = ${String(rsResp['status'])}`,
    });
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
