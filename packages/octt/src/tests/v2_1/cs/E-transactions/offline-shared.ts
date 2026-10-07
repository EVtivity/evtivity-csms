// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsTestContext, StepResult } from '../../../../cs-types.js';
import {
  setVariables,
  sleep,
  waitForChargingState,
  type VariableSetting,
} from '../../../../cs-test-helpers.js';

/** <Configured transaction_updated_metervalues_interval> (seconds). */
export const TX_UPDATED_INTERVAL_S = 2;
/** <Configured RetryBackOffWaitMinimum_duration> (seconds), greater than the meter interval. */
export const RETRY_BACKOFF_WAIT_MINIMUM_S = 6;
/** <Configured Transaction Duration> (seconds) for manual actions while offline. */
export const TRANSACTION_DURATION_S = 3;

/** Answers station-initiated messages like the Test System (CSMS role). */
export function useCsmsHandler(
  ctx: CsTestContext,
  authorize: Record<string, unknown> = { idTokenInfo: { status: 'Accepted' } },
): void {
  ctx.server.setMessageHandler(async (action: string) => {
    if (action === 'BootNotification')
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') return authorize;
    return {};
  });
}

/**
 * Configuration State shared by the offline test cases: sampled TxUpdated
 * meter values and a reconnect back-off that is shorter than OfflineThreshold.
 */
export function offlineConfiguration(extraWaitS = 0): VariableSetting[] {
  const waitMinimum = RETRY_BACKOFF_WAIT_MINIMUM_S + extraWaitS;
  return [
    {
      component: 'SampledDataCtrlr',
      variable: 'TxUpdatedMeasurands',
      value: 'Energy.Active.Import.Register',
    },
    {
      component: 'SampledDataCtrlr',
      variable: 'TxUpdatedInterval',
      value: String(TX_UPDATED_INTERVAL_S),
    },
    { component: 'OCPPCommCtrlr', variable: 'OfflineThreshold', value: String(waitMinimum + 60) },
    { component: 'OCPPCommCtrlr', variable: 'RetryBackOffWaitMinimum', value: String(waitMinimum) },
    { component: 'OCPPCommCtrlr', variable: 'RetryBackOffRandomRange', value: '0' },
  ];
}

/** Applies a Configuration State and records it as step 0. */
export async function applyConfiguration(
  ctx: CsTestContext,
  settings: VariableSetting[],
  steps: StepResult[],
): Promise<boolean> {
  const notAccepted = await setVariables(ctx.server, settings);
  steps.push({
    step: 0,
    description: 'Before: Configuration State (SetVariablesRequest)',
    status: notAccepted.length === 0 ? 'passed' : 'failed',
    expected: 'All variables Accepted',
    actual: notAccepted.length === 0 ? 'All Accepted' : notAccepted.join(', '),
  });
  return notAccepted.length === 0;
}

/**
 * Reusable State EnergyTransferStarted: connect the EV, present the idToken,
 * and wait until the transaction reports chargingState Charging. Returns the
 * transactionId, or null when the state was not reached.
 */
export async function energyTransferStarted(
  ctx: CsTestContext,
  idToken: string,
  steps: StepResult[],
): Promise<string | null> {
  await ctx.station.plugIn(1);
  await ctx.station.authorize(1, idToken);
  const charging = await waitForChargingState(ctx.server, 'Charging', 10_000);
  const txInfo = charging?.['transactionInfo'] as Record<string, unknown> | undefined;
  const transactionId = (txInfo?.['transactionId'] as string | undefined) ?? null;
  steps.push({
    step: 0,
    description: 'Before: Reusable State EnergyTransferStarted',
    status: transactionId != null ? 'passed' : 'failed',
    expected: 'TransactionEventRequest with chargingState Charging',
    actual: transactionId != null ? `transactionId ${transactionId}` : 'not received',
  });
  return transactionId;
}

/** The Test System closes the WebSocket connection AND does not accept a reconnect. */
export function closeConnectionAndRefuse(ctx: CsTestContext): void {
  ctx.server.disconnectStation(true);
}

/** The Test System accepts the next reconnection attempt and waits for it. */
export async function acceptReconnect(ctx: CsTestContext, steps: StepResult[]): Promise<boolean> {
  ctx.server.acceptConnections();
  let failure: string | null = null;
  try {
    await ctx.server.waitForConnection(90_000);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const connected = failure == null;
  steps.push({
    step: 0,
    description: 'Charging Station reconnects after the Test System accepts reconnection',
    status: connected ? 'passed' : 'failed',
    expected: 'WebSocket connection restored',
    actual: failure ?? 'Connected',
  });
  return connected;
}

/**
 * Collects the TransactionEventRequests the station delivers from its queue
 * after the connection is restored: every TransactionEvent up to the first
 * one generated online again (offline absent), or until the station is quiet.
 */
export async function collectQueuedTransactionEvents(
  ctx: CsTestContext,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>[]> {
  const queued: Record<string, unknown>[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await ctx.server.waitForMessageOrNull(
      'TransactionEvent',
      queued.length === 0 ? deadline - Date.now() : Math.min(5000, deadline - Date.now()),
    );
    if (msg == null) break;
    if (msg['offline'] !== true) {
      // The first message generated after reconnecting ends the queue, unless
      // nothing was queued yet: then it is a validation failure for the caller.
      if (queued.length === 0) queued.push(msg);
      break;
    }
    queued.push(msg);
  }
  return queued;
}

export const describeTx = (msg: Record<string, unknown>): string => {
  const info = msg['transactionInfo'] as Record<string, unknown> | undefined;
  return `${String(msg['eventType'])}/${String(msg['triggerReason'])}/offline=${String(msg['offline'])}/seqNo=${String(msg['seqNo'])}/tx=${String(info?.['transactionId'])}`;
};

/** Present the idToken while offline, end the transaction, unplug, and wait. */
export async function stopWhileOffline(
  ctx: CsTestContext,
  idToken: string,
  waitS = TRANSACTION_DURATION_S,
): Promise<void> {
  // Manual Action: Present the same idToken as used to start the transaction.
  await ctx.station.authorize(1, idToken);
  // Manual Action: Disconnect the EV and EVSE.
  await ctx.station.unplug(1);
  // The tool waits <Configured Transaction Duration> seconds.
  await sleep(waitS * 1000);
}
