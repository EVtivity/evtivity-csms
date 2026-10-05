// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import type { StepResult } from './types.js';

/**
 * A transactionId for a test station, unique across the tests of a run. The CSMS
 * keys transactions by transactionId alone, so two tests running concurrently must
 * never send the same one: a millisecond timestamp alone collides. At most 31
 * characters for the longest prefix (CiString36).
 */
export function newTransactionId(prefix: string): string {
  return `${prefix}-${String(Date.now())}-${randomBytes(3).toString('hex')}`;
}

// For empty-CALLRESULT OCPP messages (StatusNotification, FirmwareStatusNotification, etc.)
// the only conformance check is that sendCall returned (a CALLERROR throws instead).
export function pushSendAckStep(
  steps: StepResult[],
  step: number,
  description: string,
  response: unknown,
  expectedDetail?: string,
  actualDetail?: string,
): void {
  const ok = response != null;
  steps.push({
    step,
    description,
    status: ok ? 'passed' : 'failed',
    expected: expectedDetail ?? 'Response received',
    actual: ok ? (actualDetail ?? 'Response received') : 'No response',
  });
}

/**
 * Station-side messages a test sends after answering a CSMS call, such as the
 * transaction end and reboot after a ResetRequest. The test waits for the
 * sequence to finish (waitForStationSequence) instead of sleeping a fixed time,
 * which runs out when the CSMS answers slowly under load.
 */
export interface StationSequence {
  done: boolean;
  /** Why the sequence stopped early (a failed or timed out call), else null. */
  error: string | null;
}

/** Runs `steps` after `delayMs` (the station's reaction time) and tracks the outcome. */
export function startStationSequence(steps: () => Promise<void>, delayMs = 500): StationSequence {
  const sequence: StationSequence = { done: false, error: null };
  setTimeout(() => {
    steps()
      .catch((err: unknown) => {
        sequence.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        sequence.done = true;
      });
  }, delayMs);
  return sequence;
}

/** Bound for a station sequence: a few CALLs, each with the client's 30 s timeout. */
export const STATION_SEQUENCE_TIMEOUT_MS = 90_000;

/**
 * Waits until the sequence finished. Returns null when it completed, or a
 * description of why it did not (for the failed step's `actual`).
 */
export async function waitForStationSequence(
  sequence: StationSequence | null,
  timeoutMs = STATION_SEQUENCE_TIMEOUT_MS,
): Promise<string | null> {
  if (sequence == null) return 'Station sequence not started (no ResetRequest received)';
  const deadline = Date.now() + timeoutMs;
  while (!sequence.done && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!sequence.done) {
    return `Station sequence not finished within ${String(timeoutMs / 1000)} s`;
  }
  return sequence.error != null ? `Station sequence failed: ${sequence.error}` : null;
}
