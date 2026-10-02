// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createPublicKey } from 'node:crypto';
import type { CsTestContext, StepResult } from '../../../../cs-types.js';
import type { TestResult } from '../../../../types.js';
import {
  setVariables,
  sleep,
  waitForChargingState,
  waitForTransactionEventType,
} from '../../../../cs-test-helpers.js';

/** <Configured ..._tx_ended_meter_values_interval> (seconds). */
const TX_ENDED_INTERVAL_S = 3;
/** <Configured transaction duration> (seconds). */
const TRANSACTION_DURATION_S = 10;
const TOKEN = 'OCTT-TOKEN-001';

type MeterValue = { timestamp?: string; sampledValue?: Array<Record<string, unknown>> };

/** publicKey is "" or a valid public key (J02.FR.23 `oca:<enc>:asn1:<key>` or base64 SPKI). */
function isValidPublicKey(publicKey: string): boolean {
  if (publicKey === '') return true;
  try {
    const parts = publicKey.split(':');
    const der =
      parts.length === 4 && parts[0] === 'oca'
        ? Buffer.from(parts[3] ?? '', parts[1] === 'base16' ? 'hex' : 'base64')
        : Buffer.from(publicKey, 'base64');
    createPublicKey({ key: der, format: 'der', type: 'spki' });
    return true;
  } catch {
    return false;
  }
}

/**
 * TC_J_04_CS (clock-aligned) and TC_J_11_CS (sampled): signed meter values in
 * the TransactionEventRequest Ended.
 */
export async function signedTxEndedMeterValues(
  ctx: CsTestContext,
  kind: 'aligned' | 'sampled',
): Promise<TestResult> {
  const steps: StepResult[] = [];
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') return { idTokenInfo: { status: 'Accepted' } };
    return {};
  });

  const component = kind === 'aligned' ? 'AlignedDataCtrlr' : 'SampledDataCtrlr';
  const context = kind === 'aligned' ? 'Sample.Clock' : 'Sample.Periodic';
  const measurands = ['Energy.Active.Import.Register'];

  // Configuration State
  const notAccepted = await setVariables(ctx.server, [
    { component, variable: 'TxEndedInterval', value: String(TX_ENDED_INTERVAL_S) },
    { component, variable: 'TxEndedMeasurands', value: measurands.join(',') },
    { component, variable: 'SignReadings', value: 'true' },
  ]);
  steps.push({
    step: 0,
    description: `Before: ${component} TxEndedInterval, TxEndedMeasurands, SignReadings true`,
    status: notAccepted.length === 0 ? 'passed' : 'failed',
    expected: 'All variables Accepted',
    actual: notAccepted.length === 0 ? 'All Accepted' : notAccepted.join(', '),
  });

  // Reusable State EnergyTransferStarted
  await ctx.station.plugIn(1);
  await ctx.station.authorize(1, TOKEN);
  const charging = await waitForChargingState(ctx.server, 'Charging', 10_000);
  steps.push({
    step: 0,
    description: 'Before: Reusable State EnergyTransferStarted',
    status: charging != null ? 'passed' : 'failed',
    expected: 'TransactionEventRequest with chargingState Charging',
    actual: charging != null ? 'Charging' : 'not received',
  });
  if (charging == null) return { status: 'failed', durationMs: 0, steps };

  // Step 1: after <Configured transaction duration>, Reusable State
  // ParkingBayUnoccupied: present the idToken (stop) and disconnect the EV.
  await sleep(TRANSACTION_DURATION_S * 1000);
  await ctx.station.authorize(1, TOKEN);
  await ctx.station.unplug(1);
  const ended = await waitForTransactionEventType(ctx.server, 'Ended', 15_000);

  // Post scenario validations
  const meterValues = (ended?.['meterValue'] ?? []) as MeterValue[];
  steps.push({
    step: 1,
    description: 'TransactionEventRequest Ended contains the meterValue field',
    status: meterValues.length > 0 ? 'passed' : 'failed',
    expected: 'meterValue present',
    actual: ended == null ? 'Ended not received' : `${String(meterValues.length)} meterValue(s)`,
  });

  const collected = meterValues.filter((mv) => mv.sampledValue?.[0]?.['context'] === context);
  const times = collected.map((mv) => Date.parse(mv.timestamp ?? ''));
  const gaps = times.slice(1).map((t, i) => Math.round((t - (times[i] ?? t)) / 1000));
  steps.push({
    step: 1,
    description: `meterValue elements per data collection moment: sampledValue[0].context ${context}, ${String(TX_ENDED_INTERVAL_S)} s apart`,
    status:
      collected.length >= 2 && gaps.every((g) => Math.abs(g - TX_ENDED_INTERVAL_S) <= 1)
        ? 'passed'
        : 'failed',
    expected: `At least 2 ${context} elements, interval ${String(TX_ENDED_INTERVAL_S)} s`,
    actual: `${String(collected.length)} element(s), intervals ${gaps.join(',') || 'n/a'} s`,
  });

  if (kind === 'sampled') {
    const hasEnd = meterValues.some((mv) =>
      (mv.sampledValue ?? []).some((sv) => sv['context'] === 'Transaction.End'),
    );
    steps.push({
      step: 1,
      description: 'One sampledValue has context Transaction.End',
      status: hasEnd ? 'passed' : 'failed',
      expected: 'Transaction.End present',
      actual: hasEnd ? 'present' : 'absent',
    });
  }

  const collectedValues = collected.flatMap((mv) => mv.sampledValue ?? []);
  const measurandsOk = collected.every((mv) =>
    measurands.every((m) =>
      (mv.sampledValue ?? []).some(
        (sv) => sv['measurand'] === m || (sv['measurand'] == null && m === measurands[0]),
      ),
    ),
  );
  steps.push({
    step: 1,
    description: `sampledValue contains an element per ${component}.TxEndedMeasurands measurand`,
    status: collected.length > 0 && measurandsOk ? 'passed' : 'failed',
    expected: measurands.join(','),
    actual: collectedValues.map((sv) => String(sv['measurand'])).join(','),
  });

  const unsigned = collectedValues.filter((sv) => sv['signedMeterValue'] == null);
  const badKeys = collectedValues.filter((sv) => {
    const signed = sv['signedMeterValue'] as Record<string, unknown> | undefined;
    const key = signed?.['publicKey'];
    return signed != null && (typeof key !== 'string' || !isValidPublicKey(key));
  });
  steps.push({
    step: 1,
    description: 'sampledValue.signedMeterValue present with publicKey "" or a valid public key',
    status:
      collectedValues.length > 0 && unsigned.length === 0 && badKeys.length === 0
        ? 'passed'
        : 'failed',
    expected: 'signedMeterValue on every sampledValue, publicKey present',
    actual: `${String(unsigned.length)} unsigned, ${String(badKeys.length)} invalid publicKey of ${String(collectedValues.length)}`,
  });

  const evLocation = meterValues
    .flatMap((mv) => mv.sampledValue ?? [])
    .filter((sv) => sv['location'] === 'EV' && sv['measurand'] !== 'SoC');
  steps.push({
    step: 1,
    description: 'No sampledValue has location EV, except SoC',
    status: evLocation.length === 0 ? 'passed' : 'failed',
    expected: 'no location EV',
    actual: `${String(evLocation.length)} with location EV`,
  });

  const allPassed = steps.every((s) => s.status === 'passed');
  return { status: allPassed ? 'passed' : 'failed', durationMs: 0, steps };
}
