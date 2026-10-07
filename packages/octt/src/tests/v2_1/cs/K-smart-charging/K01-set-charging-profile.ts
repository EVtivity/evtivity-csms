// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestCase, CsTestContext, StepResult } from '../../../../cs-types.js';
import type { TestResult } from '../../../../types.js';
import { setVariables, sleep, startAndWaitForCharging } from '../../../../cs-test-helpers.js';

const MODULE = 'K-smart-charging';
const EVSE_ID = 1;
const EVSE_COUNT = 1;
const TOKEN = 'OCTT-TOKEN-001';
/** <Configured chargingRateUnit>, <Configured numberPhases>; limit multiplier 1 for A. */
const RATE_UNIT = 'A';
const PHASES = 3;
/** <Configured duration> (s). */
const DURATION_S = 300;
/** <Configured max time deviation> (s). */
const MAX_DEVIATION_S = 2;
/** Local limit of the test station in A (22 kW, 3 phases, 230 V). */
const LOCAL_LIMIT_A = 32;
/** <Configured maxOfflineDuration> (s), above the reconnect back-off of a brief offline period. */
const MAX_OFFLINE_S = 10;

const passOrFail = (ok: boolean): 'passed' | 'failed' => (ok ? 'passed' : 'failed');
const result = (steps: StepResult[]): TestResult => ({
  status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
  durationMs: 0,
  steps,
});
const iso = (offsetS: number): string => new Date(Date.now() + offsetS * 1000).toISOString();

function useCsmsHandler(ctx: CsTestContext): void {
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    return {};
  });
}

const create = (
  id: string,
  name: string,
  purpose: string,
  execute: (ctx: CsTestContext) => Promise<TestResult>,
): CsTestCase => ({
  id,
  name,
  module: MODULE,
  version: 'ocpp2.1',
  sut: 'cs',
  description:
    'The CSMS sends a SetChargingProfileRequest to the Charging Station to influence the power or current drawn by EVs.',
  purpose,
  timeoutMs: 180_000,
  execute,
});

let nextProfileId = 100 + Math.floor(Math.random() * 1000);

interface ProfileSpec {
  id?: number;
  purpose: string;
  kind?: string;
  stackLevel?: number;
  limit?: number;
  schedule?: Record<string, unknown>;
  period?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

function chargingProfile(spec: ProfileSpec): Record<string, unknown> {
  const id = spec.id ?? ++nextProfileId;
  return {
    id,
    stackLevel: spec.stackLevel ?? 0,
    chargingProfilePurpose: spec.purpose,
    chargingProfileKind: spec.kind ?? 'Absolute',
    ...spec.extra,
    chargingSchedule: [
      {
        id,
        chargingRateUnit: RATE_UNIT,
        ...(spec.kind === 'Relative' ? {} : { startSchedule: iso(-MAX_DEVIATION_S) }),
        ...spec.schedule,
        chargingSchedulePeriod: [
          { startPeriod: 0, limit: spec.limit ?? 6, numberPhases: PHASES, ...spec.period },
        ],
      },
    ],
  };
}

async function setProfile(
  ctx: CsTestContext,
  steps: StepResult[],
  step: number,
  evseId: number,
  profile: Record<string, unknown>,
  expected: string,
  reasonCodes?: string[],
): Promise<void> {
  const resp = await ctx.server.sendCommand('SetChargingProfile', {
    evseId,
    chargingProfile: profile,
  });
  const reason = (resp['statusInfo'] as Record<string, unknown> | undefined)?.['reasonCode'];
  steps.push({
    step,
    description: `SetChargingProfileResponse ${expected} (${String(profile['chargingProfilePurpose'])}, EVSE ${String(evseId)})`,
    status: passOrFail(
      resp['status'] === expected &&
        (reasonCodes == null || reason == null || reasonCodes.includes(String(reason))),
    ),
    expected:
      reasonCodes != null
        ? `${expected}, reasonCode ${reasonCodes.join('/')} or omitted`
        : expected,
    actual: `${String(resp['status'])}${reason != null ? `, ${String(reason)}` : ''}`,
  });
}

/** GetChargingProfiles for one profile id; validates the report against the sent profile. */
async function reportStep(
  ctx: CsTestContext,
  steps: StepResult[],
  step: number,
  profile: Record<string, unknown>,
  evseId: number,
): Promise<void> {
  const requestId = Math.floor(Math.random() * 1_000_000);
  const resp = await ctx.server.sendCommand('GetChargingProfiles', {
    requestId,
    chargingProfile: { chargingProfileId: [profile['id']] },
  });
  steps.push({
    step,
    description: 'GetChargingProfilesResponse Accepted',
    status: passOrFail(resp['status'] === 'Accepted'),
    expected: 'Accepted',
    actual: String(resp['status']),
  });
  let report: Record<string, unknown> | null = null;
  report = await ctx.server.waitForMessageOrNull('ReportChargingProfiles', 10_000);
  const reported = ((report?.['chargingProfile'] ?? []) as Array<Record<string, unknown>>).find(
    (p) => p['id'] === profile['id'],
  );
  steps.push({
    step: step + 1,
    description: `ReportChargingProfilesRequest: requestId, EVSE ${String(evseId)}, the profile as sent`,
    status: passOrFail(
      report?.['requestId'] === requestId &&
        report['evseId'] === evseId &&
        report['tbc'] !== true &&
        JSON.stringify(reported) === JSON.stringify(profile),
    ),
    expected: `requestId ${String(requestId)}, evseId ${String(evseId)}, ${JSON.stringify(profile)}`,
    actual:
      report == null
        ? 'not received'
        : `requestId ${String(report['requestId'])}, evseId ${String(report['evseId'])}, ${JSON.stringify(reported)}`,
  });
}

async function composite(
  ctx: CsTestContext,
  evseId: number,
  durationS: number,
): Promise<{ resp: Record<string, unknown>; sentAt: number }> {
  const sentAt = Date.now();
  const resp = await ctx.server.sendCommand('GetCompositeSchedule', {
    evseId,
    duration: durationS,
    chargingRateUnit: RATE_UNIT,
  });
  return { resp, sentAt };
}

type Period = { startPeriod: number; limit: number };
const periodsOf = (resp: Record<string, unknown>): Period[] =>
  ((resp['schedule'] as Record<string, unknown> | undefined)?.['chargingSchedulePeriod'] ??
    []) as Period[];

/** GetCompositeSchedule validation: header fields plus the expected periods (startPeriod +/- tolerance). */
function compositeStep(
  step: number,
  c: { resp: Record<string, unknown>; sentAt: number },
  evseId: number,
  durationS: number,
  expected: Period[],
): StepResult {
  const schedule = c.resp['schedule'] as Record<string, unknown> | undefined;
  const start = Date.parse(String(schedule?.['scheduleStart']));
  const periods = periodsOf(c.resp);
  const matches =
    periods.length === expected.length &&
    expected.every(
      (e, i) =>
        Math.abs((periods[i]?.startPeriod ?? -1) - e.startPeriod) <= MAX_DEVIATION_S &&
        periods[i]?.limit === e.limit,
    );
  return {
    step,
    description: 'GetCompositeScheduleResponse Accepted with the expected periods',
    status: passOrFail(
      c.resp['status'] === 'Accepted' &&
        schedule?.['evseId'] === evseId &&
        schedule['duration'] === durationS &&
        schedule['chargingRateUnit'] === RATE_UNIT &&
        Math.abs(start - c.sentAt) <= MAX_DEVIATION_S * 1000 &&
        matches,
    ),
    expected: `evseId ${String(evseId)}, duration ${String(durationS)}, ${RATE_UNIT}, periods ${JSON.stringify(expected)}`,
    actual: JSON.stringify(c.resp),
  };
}

async function energyTransferStarted(
  ctx: CsTestContext,
  steps: StepResult[],
): Promise<string | null> {
  const charging = await startAndWaitForCharging(ctx, EVSE_ID, TOKEN);
  const txId =
    ((charging?.['transactionInfo'] as Record<string, unknown> | undefined)?.['transactionId'] as
      | string
      | undefined) ?? null;
  steps.push({
    step: 0,
    description: 'Reusable State EnergyTransferStarted',
    status: passOrFail(txId != null),
    expected: 'chargingState Charging',
    actual: txId ?? 'not reached',
  });
  return txId;
}

async function booted(ctx: CsTestContext, steps: StepResult[], step: number): Promise<void> {
  const reset = await ctx.server.sendCommand('Reset', { type: 'Immediate' });
  let ok = reset['status'] === 'Accepted';
  if ((await ctx.server.waitForMessageOrNull('BootNotification', 15_000)) == null) {
    ok = false;
  }
  steps.push({
    step,
    description: 'Reusable State Booted (Reset Immediate, BootNotification)',
    status: passOrFail(ok),
    expected: 'booted',
    actual: ok ? 'booted' : `reset ${String(reset['status'])}`,
  });
  await sleep(500);
}

export const TC_K_03_CS = create(
  'TC_K_03_CS',
  'Set Charging Profile - ChargingStationMaxProfile',
  'To verify that the Charging Station accepts and reports a ChargingStationMaxProfile on EVSE 0.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const profile = chargingProfile({
      purpose: 'ChargingStationMaxProfile',
      schedule: { duration: DURATION_S },
    });
    await setProfile(ctx, steps, 2, 0, profile, 'Accepted');
    await reportStep(ctx, steps, 4, profile, 0);
    return result(steps);
  },
);

export const TC_K_04_CS = create(
  'TC_K_04_CS',
  'Replace charging profile - With chargingProfileId',
  'To verify that a profile with the same id replaces the installed one.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const original = chargingProfile({ purpose: 'TxDefaultProfile', limit: 6 });
    await setProfile(ctx, steps, 0, EVSE_ID, original, 'Accepted');
    const replacement = chargingProfile({
      id: original['id'] as number,
      purpose: 'TxDefaultProfile',
      limit: 10,
    });
    await setProfile(ctx, steps, 2, EVSE_ID, replacement, 'Accepted');
    await reportStep(ctx, steps, 4, replacement, EVSE_ID);
    return result(steps);
  },
);

export const TC_K_10_CS = create(
  'TC_K_10_CS',
  'Set Charging Profile - TxDefaultProfile - All EVSE',
  'To verify that the Charging Station accepts and reports a TxDefaultProfile for all EVSE.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const profile = chargingProfile({
      purpose: 'TxDefaultProfile',
      schedule: { duration: DURATION_S },
    });
    await setProfile(ctx, steps, 2, 0, profile, 'Accepted');
    await reportStep(ctx, steps, 4, profile, 0);
    return result(steps);
  },
);

export const TC_K_11_CS = create(
  'TC_K_11_CS',
  'Set Charging Profile - Unable to set TxProfile on all EVSE at once',
  'To verify that the Charging Station rejects a TxProfile on EVSE 0.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await setProfile(ctx, steps, 2, 0, chargingProfile({ purpose: 'TxProfile' }), 'Rejected');
    return result(steps);
  },
);

export const TC_K_12_CS = create(
  'TC_K_12_CS',
  'Set Charging Profile - ChargerRateUnit Rejected',
  'To verify that the Charging Station rejects a chargingRateUnit it does not support.',
  async (ctx) => {
    // Applies to a station that supports only one of A and W (PICS SC-2); the
    // simulator supports both, so the runner reports it notApplicable.
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const profile = chargingProfile({
      purpose: 'TxDefaultProfile',
      schedule: { chargingRateUnit: 'W' },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Rejected');
    return result(steps);
  },
);

export const TC_K_13_CS = create(
  'TC_K_13_CS',
  'Set Charging Profile - Persistent over reboot',
  'To verify that a charging profile persists over a reboot.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const profile = chargingProfile({
      purpose: 'TxDefaultProfile',
      schedule: { duration: DURATION_S },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Accepted');
    await booted(ctx, steps, 3);
    await reportStep(ctx, steps, 5, profile, EVSE_ID);
    return result(steps);
  },
);

export const TC_K_14_CS = create(
  'TC_K_14_CS',
  'Set Charging Profile - Unexisting EVSEid',
  'To verify that the Charging Station rejects a profile for an unknown EVSE.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    await setProfile(
      ctx,
      steps,
      2,
      EVSE_COUNT + 1,
      chargingProfile({ purpose: 'TxDefaultProfile' }),
      'Rejected',
    );
    return result(steps);
  },
);

export const TC_K_15_CS = create(
  'TC_K_15_CS',
  'Set Charging Profile - Not Supported',
  'To verify that a Charging Station without smart charging answers NotSupported.',
  async (ctx) => {
    // Applies to a station without smart charging; the simulator supports it,
    // so the runner reports it notApplicable.
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    let error = '';
    try {
      await ctx.server.sendCommand('SetChargingProfile', {
        evseId: EVSE_ID,
        chargingProfile: chargingProfile({ purpose: 'TxDefaultProfile' }),
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    steps.push({
      step: 2,
      description: 'CALLERROR NotSupported',
      status: passOrFail(error.includes('NotSupported')),
      expected: 'CALLERROR NotSupported',
      actual: error || 'a response',
    });
    return result(steps);
  },
);

export const TC_K_16_CS = create(
  'TC_K_16_CS',
  'Set Charging Profile - Unknown transactionId',
  'To verify that the Charging Station rejects a TxProfile for an unknown transaction.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    if ((await energyTransferStarted(ctx, steps)) == null) return result(steps);
    const profile = chargingProfile({
      purpose: 'TxProfile',
      extra: { transactionId: 'UNKNOWN-TRANSACTION-ID' },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Rejected');
    return result(steps);
  },
);

export const TC_K_19_CS = create(
  'TC_K_19_CS',
  'Set Charging Profile - ChargingProfileKind is Recurring',
  'To verify that the Charging Station accepts a recurring profile.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const profile = chargingProfile({
      purpose: 'TxDefaultProfile',
      kind: 'Recurring',
      extra: { recurrencyKind: 'Daily' },
      schedule: { startSchedule: iso(-60), duration: 3600 },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Accepted');
    return result(steps);
  },
);

export const TC_K_21_CS = create(
  'TC_K_21_CS',
  'Set Charging Profile - ValidFrom',
  'To verify that a profile becomes active at its validFrom.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const setAt = Date.now();
    const profile = chargingProfile({
      purpose: 'TxDefaultProfile',
      kind: 'Relative',
      extra: { validFrom: iso(300) },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Accepted');
    const c = await composite(ctx, EVSE_ID, 400);
    const x = Math.round((c.sentAt - setAt) / 1000);
    steps.push(
      compositeStep(4, c, EVSE_ID, 400, [
        { startPeriod: 0, limit: LOCAL_LIMIT_A },
        { startPeriod: 300 - x, limit: 6 },
      ]),
    );
    return result(steps);
  },
);

export const TC_K_22_CS = create(
  'TC_K_22_CS',
  'Set Charging Profile - ValidTo',
  'To verify that a profile stops applying at its validTo.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const setAt = Date.now();
    const profile = chargingProfile({
      purpose: 'TxDefaultProfile',
      extra: { validFrom: iso(-MAX_DEVIATION_S), validTo: iso(300) },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Accepted');
    const c = await composite(ctx, EVSE_ID, 400);
    const x = Math.round((c.sentAt - setAt) / 1000);
    steps.push(
      compositeStep(4, c, EVSE_ID, 400, [
        { startPeriod: 0, limit: 6 },
        { startPeriod: 300 - x, limit: LOCAL_LIMIT_A },
      ]),
    );
    return result(steps);
  },
);

export const TC_K_23_CS = create(
  'TC_K_23_CS',
  'Set Charging Profile - StartSchedule',
  'To verify that an absolute profile starts at its startSchedule.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const setAt = Date.now();
    const profile = chargingProfile({
      purpose: 'TxDefaultProfile',
      schedule: { startSchedule: iso(60) },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Accepted');
    const c = await composite(ctx, EVSE_ID, 300);
    const x = Math.round((c.sentAt - setAt) / 1000);
    steps.push(
      compositeStep(4, c, EVSE_ID, 300, [
        { startPeriod: 0, limit: LOCAL_LIMIT_A },
        { startPeriod: 60 - x, limit: 6 },
      ]),
    );
    return result(steps);
  },
);

export const TC_K_28_CS = create(
  'TC_K_28_CS',
  'Set Charging Profile - TxDefaultProfile with transaction ongoing',
  'To verify that a TxDefaultProfile applies to the ongoing transaction.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    if ((await energyTransferStarted(ctx, steps)) == null) return result(steps);
    const profile = chargingProfile({
      purpose: 'TxDefaultProfile',
      schedule: { duration: 400 + MAX_DEVIATION_S },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Accepted');
    const c = await composite(ctx, EVSE_ID, 300);
    steps.push(compositeStep(4, c, EVSE_ID, 300, [{ startPeriod: 0, limit: 6 }]));
    return result(steps);
  },
);

export const TC_K_60_CS = create(
  'TC_K_60_CS',
  'Set Charging Profile - TxProfile with ongoing transaction on the specified EVSE',
  'To verify that the Charging Station accepts and reports a TxProfile for the ongoing transaction.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const txId = await energyTransferStarted(ctx, steps);
    if (txId == null) return result(steps);
    const profile = chargingProfile({
      purpose: 'TxProfile',
      kind: 'Relative',
      extra: { transactionId: txId },
    });
    await setProfile(ctx, steps, 2, EVSE_ID, profile, 'Accepted');
    await reportStep(ctx, steps, 4, profile, EVSE_ID);
    return result(steps);
  },
);

export const TC_K_100_CS = create(
  'TC_K_100_CS',
  'Set Charging Profile - maxOfflineDuration',
  'To verify that a profile with maxOfflineDuration stops applying after a longer offline period.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    // Configuration State: a short reconnect back-off, so a brief offline period
    // stays below maxOfflineDuration (OCPP 2.1 Part 4, 5.4).
    const rejected = await setVariables(ctx.server, [
      { component: 'OCPPCommCtrlr', variable: 'RetryBackOffWaitMinimum', value: '1' },
      { component: 'OCPPCommCtrlr', variable: 'RetryBackOffRandomRange', value: '0' },
    ]);
    steps.push({
      step: 1,
      description: 'Configuration State: RetryBackOffWaitMinimum 1, RetryBackOffRandomRange 0',
      status: passOrFail(rejected.length === 0),
      expected: 'Accepted',
      actual: rejected.length === 0 ? 'Accepted' : rejected.join(', '),
    });
    const base = chargingProfile({ purpose: 'TxDefaultProfile', stackLevel: 0, limit: 6 });
    await setProfile(ctx, steps, 2, 0, base, 'Accepted');
    const id2 = ++nextProfileId;
    const offlineProfile = (limit: number, maxOffline: number, invalidAfter: boolean) =>
      chargingProfile({
        id: id2,
        purpose: 'TxDefaultProfile',
        stackLevel: 1,
        limit,
        extra: { maxOfflineDuration: maxOffline, invalidAfterOfflineDuration: invalidAfter },
      });
    await setProfile(ctx, steps, 4, 0, offlineProfile(7, MAX_OFFLINE_S, true), 'Accepted');
    if ((await energyTransferStarted(ctx, steps)) == null) return result(steps);

    const offline = async (waitS: number): Promise<void> => {
      ctx.server.disconnectStation(true);
      await sleep(waitS * 1000);
      ctx.server.acceptConnections();
      await ctx.server.waitForConnection(90_000);
      await sleep(1000);
    };
    const limitStep = async (step: number, limit: number): Promise<void> => {
      const c = await composite(ctx, EVSE_ID, 900);
      const first = periodsOf(c.resp)[0];
      steps.push({
        step,
        description: `GetCompositeScheduleResponse: first period limit ${String(limit)}`,
        status: passOrFail(
          c.resp['status'] === 'Accepted' && first?.startPeriod === 0 && first.limit === limit,
        ),
        expected: `startPeriod 0, limit ${String(limit)}`,
        actual: JSON.stringify(periodsOf(c.resp)),
      });
    };

    // Step 6-9: a short offline period keeps the profile
    await offline(0);
    await limitStep(9, 7);
    // Step 10-14: offline longer than maxOfflineDuration invalidates it
    await offline(MAX_OFFLINE_S + 1);
    await limitStep(14, 6);
    // Step 15-21: invalidAfterOfflineDuration false keeps it after reconnecting
    await setProfile(ctx, steps, 16, 0, offlineProfile(8, MAX_OFFLINE_S, false), 'Accepted');
    await offline(MAX_OFFLINE_S + 1);
    await limitStep(21, 8);
    // Step 22-27: maxOfflineDuration 0 with invalidAfterOfflineDuration
    await setProfile(ctx, steps, 23, 0, offlineProfile(9, 0, true), 'Accepted');
    await offline(0);
    await limitStep(27, 6);
    return result(steps);
  },
);

export const TC_K_105_CS = create(
  'TC_K_105_CS',
  'Set Charging Profile - ChargingStationMaxProfile persistent over reboot',
  'To verify that a ChargingStationMaxProfile persists over a reboot.',
  async (ctx) => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const profile = chargingProfile({
      purpose: 'ChargingStationMaxProfile',
      schedule: { duration: DURATION_S },
    });
    await setProfile(ctx, steps, 2, 0, profile, 'Accepted');
    await booted(ctx, steps, 3);
    await reportStep(ctx, steps, 5, profile, 0);
    return result(steps);
  },
);

/** TC_K_130-135: a purpose or schedule feature the simulator does not support. */
function unsupported(
  purpose: string,
  schedule: Record<string, unknown>,
  period: Record<string, unknown>,
  limit: number,
  reasonCodes: string[],
) {
  return async (ctx: CsTestContext): Promise<TestResult> => {
    const steps: StepResult[] = [];
    useCsmsHandler(ctx);
    const profile = chargingProfile({ id: 1, purpose, limit, schedule, period });
    await setProfile(ctx, steps, 2, 0, profile, 'Rejected', reasonCodes);
    return result(steps);
  };
}

export const TC_K_130_CS = create(
  'TC_K_130_CS',
  'Set Charging Profile - PriorityCharging unsupported',
  'To verify that the Charging Station rejects the PriorityCharging purpose it does not support.',
  unsupported('PriorityCharging', {}, {}, 16, ['UnsupportedPurpose']),
);

export const TC_K_131_CS = create(
  'TC_K_131_CS',
  'Set Charging Profile - LocalGeneration unsupported',
  'To verify that the Charging Station rejects the LocalGeneration purpose it does not support.',
  unsupported('LocalGeneration', {}, {}, 6, ['UnsupportedPurpose']),
);

export const TC_K_132_CS = create(
  'TC_K_132_CS',
  'Set Charging Profile - useLocalTime unsupported',
  'To verify that the Charging Station rejects useLocalTime it does not support.',
  unsupported('TxProfile', { useLocalTime: true }, {}, 6, ['InvalidSchedule']),
);

export const TC_K_133_CS = create(
  'TC_K_133_CS',
  'Set Charging Profile - RandomizedDelay unsupported',
  'To verify that the Charging Station rejects randomizedDelay it does not support.',
  unsupported('TxProfile', { randomizedDelay: 10 }, {}, 6, ['InvalidSchedule']),
);

export const TC_K_134_CS = create(
  'TC_K_134_CS',
  'Set Charging Profile - LimitAtSoC unsupported',
  'To verify that the Charging Station rejects limitAtSoC it does not support.',
  unsupported('TxProfile', { limitAtSoC: { soc: 80, limit: 10 } }, {}, 6, ['InvalidSchedule']),
);

export const TC_K_135_CS = create(
  'TC_K_135_CS',
  'Idle operationMode - Set Charging Profile - EvseSleep unsupported',
  'To verify that the Charging Station rejects evseSleep it does not support.',
  unsupported('TxProfile', {}, { evseSleep: true }, 6, ['InvalidSchedule']),
);

/** Tests for features the simulator does not declare; the runner reports them notApplicable. */
const notRunnable = (reason: string) => async (): Promise<TestResult> => ({
  status: 'failed',
  durationMs: 0,
  steps: [],
  error: `Not runnable: ${reason}`,
});

export const TC_K_101_CS = create(
  'TC_K_101_CS',
  'Set Charging Profile - Change operation mode',
  'To verify that the Charging Station changes its V2X operation mode.',
  notRunnable('needs V2X operation modes (BidirectionalPowerTransfer)'),
);
export const TC_K_102_CS = create(
  'TC_K_102_CS',
  'Set Charging Profile - limitAtSoc',
  'To verify that the Charging Station applies limitAtSoC.',
  notRunnable('needs EV SoC over ISO 15118 or CHAdeMO (SC-3)'),
);
export const TC_K_103_CS = create(
  'TC_K_103_CS',
  'Set Charging Profile - Local time - TimeOffset',
  'To verify that the Charging Station applies a schedule in local time (TimeOffset).',
  notRunnable('needs useLocalTime (SC-5)'),
);
export const TC_K_136_CS = create(
  'TC_K_136_CS',
  'Set Charging Profile - Local time - TimeZone',
  'To verify that the Charging Station applies a schedule in local time (TimeZone).',
  notRunnable('needs useLocalTime (SC-5)'),
);
export const TC_K_104_CS = create(
  'TC_K_104_CS',
  'Set Charging Profile - PriorityCharging',
  'To verify that the Charging Station accepts a PriorityCharging profile.',
  notRunnable('needs PriorityCharging (SC-6)'),
);
export const TC_K_129_CS = create(
  'TC_K_129_CS',
  'Set Charging Profile - PriorityCharging persistent over reboot',
  'To verify that a PriorityCharging profile persists over a reboot.',
  notRunnable('needs PriorityCharging (SC-6)'),
);
export const TC_K_106_CS = create(
  'TC_K_106_CS',
  'Set Charging Profile - randomizedDelay',
  'To verify that the Charging Station applies randomizedDelay.',
  notRunnable('needs randomizedDelay (SC-7)'),
);
export const TC_K_107_CS = create(
  'TC_K_107_CS',
  'Set Charging Profile - randomizedDelay - validations',
  'To verify the randomizedDelay validations.',
  notRunnable('needs randomizedDelay (SC-7)'),
);
export const TC_K_108_CS = create(
  'TC_K_108_CS',
  'Set Charging Profile - randomizedDelay - random for each tx',
  'To verify that randomizedDelay is random for each transaction.',
  notRunnable('needs randomizedDelay (SC-7)'),
);
export const TC_K_109_CS = create(
  'TC_K_109_CS',
  'EMS Control - Set Charging Profile - MaxExternalConstraintsId',
  'To verify SmartChargingCtrlr.MaxExternalConstraintsId.',
  notRunnable('needs SmartChargingCtrlr.MaxExternalConstraintsId (SC-10)'),
);
export const TC_K_110_CS = create(
  'TC_K_110_CS',
  'EMS Control - Set Charging Profile - MaxExternalConstraintsId - validations',
  'To verify the MaxExternalConstraintsId validations.',
  notRunnable('needs SmartChargingCtrlr.MaxExternalConstraintsId (SC-10)'),
);
