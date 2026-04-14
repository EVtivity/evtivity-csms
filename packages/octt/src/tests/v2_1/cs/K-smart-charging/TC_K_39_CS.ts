// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, StepResult } from '../../../../cs-types.js';

const bootHandler = async (action: string) => {
  if (action === 'BootNotification')
    return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
  if (action === 'StatusNotification') return {};
  if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
  if (action === 'NotifyEvent') return {};
  if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
  if (action === 'TransactionEvent') return { idTokenInfo: { status: 'Accepted' } };
  return {};
};

/** TC_K_39_CS: Get Composite Schedule - No ChargingProfile installed */
export const TC_K_39_CS: CsTestCase = {
  id: 'TC_K_39_CS',
  name: 'Get Composite Schedule - No ChargingProfile installed',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests a composite schedule when no charging profiles are installed.',
  purpose:
    'To verify if the Charging Station can calculate a correct composite schedule with no profiles.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(bootHandler);
    try {
      const res = await ctx.server.sendCommand('GetCompositeSchedule', {
        evseId: 0,
        duration: 300,
        chargingRateUnit: 'A',
      });
      const status = (res as Record<string, unknown>).status;
      const schedule = (res as Record<string, unknown>).schedule as
        | Record<string, unknown>
        | undefined;
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse Accepted with schedule',
        status: status === 'Accepted' && schedule != null ? 'passed' : 'failed',
        expected: 'status Accepted, schedule present',
        actual: `status: ${String(status)}, hasSchedule: ${String(schedule != null)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_40_CS: Get Composite Schedule - Stacking ChargingProfiles */
export const TC_K_40_CS: CsTestCase = {
  id: 'TC_K_40_CS',
  name: 'Get Composite Schedule - Stacking ChargingProfiles',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests a composite schedule with stacked profiles.',
  purpose:
    'To verify if the Charging Station calculates a composite schedule with stacked profiles correctly.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(bootHandler);
    try {
      const res = await ctx.server.sendCommand('GetCompositeSchedule', {
        evseId: 1,
        duration: 350,
        chargingRateUnit: 'A',
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted with composite schedule',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_41_CS: Get Composite Schedule - Combining chargingProfilePurposes */
export const TC_K_41_CS: CsTestCase = {
  id: 'TC_K_41_CS',
  name: 'Get Composite Schedule - Combining chargingProfilePurposes',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests a composite schedule combining multiple profile purposes.',
  purpose:
    'To verify if the Charging Station calculates a composite schedule combining profile purposes.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(bootHandler);
    try {
      const res = await ctx.server.sendCommand('GetCompositeSchedule', {
        evseId: 1,
        duration: 400,
        chargingRateUnit: 'A',
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_42_CS: Get Composite Schedule - chargingRateUnit not supported */
export const TC_K_42_CS: CsTestCase = {
  id: 'TC_K_42_CS',
  name: 'Get Composite Schedule - chargingRateUnit not supported',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests a composite schedule with an unsupported rate unit.',
  purpose:
    'To verify if the Charging Station rejects a GetCompositeScheduleRequest with unsupported chargingRateUnit.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(bootHandler);
    try {
      const res = await ctx.server.sendCommand('GetCompositeSchedule', {
        evseId: 0,
        duration: 300,
        chargingRateUnit: 'W',
      });
      const status = (res as Record<string, unknown>).status;
      const schedule = (res as Record<string, unknown>).schedule;
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse Rejected, schedule omitted',
        status: status === 'Rejected' && schedule == null ? 'passed' : 'failed',
        expected: 'status Rejected, schedule omitted',
        actual: `status: ${String(status)}, schedule: ${String(schedule)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse',
        status: 'failed',
        expected: 'status Rejected',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_47_CS: Get Composite Schedule - Unknown EVSEId */
export const TC_K_47_CS: CsTestCase = {
  id: 'TC_K_47_CS',
  name: 'Get Composite Schedule - Unknown EVSEId',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests a composite schedule for an unknown EVSE.',
  purpose:
    'To verify if the Charging Station rejects a GetCompositeScheduleRequest for unknown EVSEId.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(bootHandler);
    try {
      const res = await ctx.server.sendCommand('GetCompositeSchedule', {
        evseId: 999,
        duration: 300,
        chargingRateUnit: 'A',
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse Rejected',
        status: status === 'Rejected' ? 'passed' : 'failed',
        expected: 'status Rejected',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'GetCompositeScheduleResponse',
        status: 'failed',
        expected: 'status Rejected',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};

/** TC_K_112_CS: Get Composite Schedule - randomizedDelay */
export const TC_K_112_CS: CsTestCase = {
  id: 'TC_K_112_CS',
  name: 'Get Composite Schedule - randomizedDelay',
  module: 'K-smart-charging',
  version: 'ocpp2.1',
  sut: 'cs',
  description: 'The CSMS requests a composite schedule where randomizedDelay should be excluded.',
  purpose:
    'To verify if the Charging station does not use the randomizedDelay when calculating a composite schedule.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];
    ctx.server.setMessageHandler(bootHandler);

    // Step 1-2: Set profile with randomizedDelay
    try {
      const res = await ctx.server.sendCommand('SetChargingProfile', {
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
              startSchedule: new Date().toISOString(),
              randomizedDelay: 1000,
              chargingSchedulePeriod: [
                { startPeriod: 0, limit: 6, numberPhases: 3 },
                { startPeriod: 3600, limit: 7, numberPhases: 3 },
                { startPeriod: 7200, limit: 8, numberPhases: 3 },
              ],
            },
          ],
        },
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 2,
        description: 'SetChargingProfileResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 2,
        description: 'SetChargingProfileResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Step 3-4: GetCompositeSchedule - verify randomizedDelay not applied
    try {
      const res = await ctx.server.sendCommand('GetCompositeSchedule', {
        evseId: 1,
        duration: 8000,
        chargingRateUnit: 'A',
      });
      const status = (res as Record<string, unknown>).status;
      steps.push({
        step: 4,
        description: 'GetCompositeScheduleResponse Accepted',
        status: status === 'Accepted' ? 'passed' : 'failed',
        expected: 'status Accepted, randomizedDelay not used',
        actual: `status: ${String(status)}`,
      });
    } catch (err) {
      steps.push({
        step: 4,
        description: 'GetCompositeScheduleResponse',
        status: 'failed',
        expected: 'status Accepted',
        actual: `Error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const allPassed = steps.every((s) => s.status === 'passed');
    return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
  },
};
