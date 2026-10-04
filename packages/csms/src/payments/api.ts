// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { api, ApiError, getApiErrorCode, getApiErrorFieldDetails } from '@/lib/api';
import type {
  SetupIntentResponse,
  SetupSession,
  SetupStepResponse,
  SetupStepResult,
  ShopperBrowser,
} from './types';

function methodsPath(driverId: string): string {
  return `/v1/drivers/${encodeURIComponent(driverId)}/payment-methods`;
}

/** Starts a card setup for the driver at the active provider and returns its session. */
export async function startSetup(driverId: string): Promise<SetupSession> {
  const data = await api.post<SetupIntentResponse>(`${methodsPath(driverId)}/setup-intent`, {});
  return data.session;
}

/**
 * One id per card attempt. The API derives the provider idempotency keys from it,
 * hashed with the driver id (`method_setup_<sha256(driverId:attemptId)[:32]>`, and the
 * details step adds the details to the hash), so a retry of one step replays it.
 */
export function newAttemptId(): string {
  return crypto.randomUUID();
}

/** A refused card is a 400 PAYMENT_FAILED with `details.reason`; other errors are thrown. */
function refusedReason(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  if (getApiErrorCode(err) !== 'PAYMENT_FAILED') return null;
  return getApiErrorFieldDetails(err)['reason'] ?? 'refused';
}

async function setupStep(path: string, body: unknown): Promise<SetupStepResult> {
  try {
    const result = await api.post<SetupStepResponse>(path, body);
    if (result.status === 'saved') return { status: 'saved' };
    return { status: 'action_required', action: result.action };
  } catch (err: unknown) {
    const reason = refusedReason(err);
    if (reason != null) return { status: 'refused', reason };
    throw err;
  }
}

export function submitSetup(
  driverId: string,
  attemptId: string,
  provider: string,
  payload: unknown,
  browser?: ShopperBrowser,
): Promise<SetupStepResult> {
  return setupStep(`${methodsPath(driverId)}/setup/submit`, {
    provider,
    attemptId,
    payload,
    ...(browser != null ? { browser } : {}),
  });
}

export function submitSetupDetails(
  driverId: string,
  attemptId: string,
  provider: string,
  details: unknown,
): Promise<SetupStepResult> {
  return setupStep(`${methodsPath(driverId)}/setup/details`, { provider, attemptId, details });
}
