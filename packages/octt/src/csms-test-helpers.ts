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
