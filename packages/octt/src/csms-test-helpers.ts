// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult } from './types.js';

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
