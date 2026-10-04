// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { api, ApiError, getApiErrorFieldDetails } from '@/lib/api';
import type {
  PaymentProviderDescriptor,
  SetupIntentResponse,
  SetupSession,
  SetupStepResponse,
  SetupStepResult,
  ShopperBrowser,
} from './types';

const METHODS_PATH = '/v1/portal/payment-methods';

export function fetchDescriptor(): Promise<PaymentProviderDescriptor> {
  return api.get<PaymentProviderDescriptor>('/v1/portal/payment-provider');
}

/** Starts a card setup at the active provider and returns its session. */
export async function startSetup(): Promise<SetupSession> {
  const data = await api.post<SetupIntentResponse>(`${METHODS_PATH}/setup-intent`, {});
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
  const body = err.body;
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null;
  if ((body as Record<string, unknown>)['code'] !== 'PAYMENT_FAILED') return null;
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
  attemptId: string,
  provider: string,
  payload: unknown,
  browser?: ShopperBrowser,
): Promise<SetupStepResult> {
  return setupStep(`${METHODS_PATH}/setup/submit`, {
    provider,
    attemptId,
    payload,
    ...(browser != null ? { browser } : {}),
  });
}

export function submitSetupDetails(
  attemptId: string,
  provider: string,
  details: unknown,
): Promise<SetupStepResult> {
  return setupStep(`${METHODS_PATH}/setup/details`, { provider, attemptId, details });
}

/** `POST /v1/portal/guest/start/...` and `.../guest/payment-details/:sessionToken` answer. */
export interface GuestStartResponse {
  status?: 'started' | 'action_required';
  sessionToken: string;
  action?: { provider: string; data: unknown };
}

/** Sends a guest's 3D Secure result; the API starts charging once the hold is authorized. */
export function submitGuestPaymentDetails(
  sessionToken: string,
  details: unknown,
): Promise<GuestStartResponse> {
  return api.post<GuestStartResponse>(
    `/v1/portal/guest/payment-details/${encodeURIComponent(sessionToken)}`,
    { details },
  );
}
