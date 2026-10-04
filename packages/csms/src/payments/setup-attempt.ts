// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { newAttemptId, submitSetup, submitSetupDetails } from './api';
import type { CardSetupProps, SetupStepResult } from './types';

export type CardSetupSteps = Pick<CardSetupProps, 'submit' | 'submitDetails'>;

/**
 * The setup steps of one opened card form for a driver. The form gets one attempt id,
 * so a replayed request (retry after a network error) hits the same idempotency key.
 * A refused card ends the attempt: the next card in the same form gets a new id,
 * because a provider rejects a reused key with a different payload.
 */
export function createCardSetupSteps(driverId: string, provider: string): CardSetupSteps {
  let attemptId = newAttemptId();

  function settle(result: SetupStepResult): SetupStepResult {
    if (result.status === 'refused') attemptId = newAttemptId();
    return result;
  }

  return {
    submit: async (payload, browser) =>
      settle(await submitSetup(driverId, attemptId, provider, payload, browser)),
    submitDetails: async (details) =>
      settle(await submitSetupDetails(driverId, attemptId, provider, details)),
  };
}
