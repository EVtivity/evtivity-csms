// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Layer 3 of "no AI analysis without consent" (plan v0.1.45, section 2.9):
 * the worker re-reads the case and refuses a model call unless the driver
 * granted consent under a released notice version. A guard test
 * (`driver-ai-consent-guard.test.ts`, TC-AI-DR-20) fails when a file under
 * `driver-ai/` calls a model without calling `assertDriverAiConsent` first.
 */

import { isKnownDriverAiNoticeVersion } from '@evtivity/lib/driver-ai';

export interface DriverAiConsentFields {
  aiConsent: string | null;
  aiConsentNoticeVersion: number | null;
}

/** Whether the stored consent allows an analysis. */
export function hasDriverAiConsent(row: DriverAiConsentFields): boolean {
  return row.aiConsent === 'granted' && isKnownDriverAiNoticeVersion(row.aiConsentNoticeVersion);
}

export class DriverAiConsentError extends Error {
  constructor(caseId: string) {
    super(`Support case ${caseId} has no valid driver AI consent`);
    this.name = 'DriverAiConsentError';
  }
}

/** Throws unless the stored consent allows an analysis. */
export function assertDriverAiConsent(caseId: string, row: DriverAiConsentFields): void {
  if (!hasDriverAiConsent(row)) throw new DriverAiConsentError(caseId);
}
