// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OCPP_VERSION_MISMATCH } from '@evtivity/lib';

/**
 * The reason the OCPP server refused a command before sending it because the
 * station's OCPP version cannot express it (a 2.1-only action or value for an
 * OCPP 2.0.1 station), or null for any other result. The station never saw the
 * command, so routes answer 400 OCPP_VERSION_MISMATCH with this reason, never a
 * station error (502).
 */
export function ocppVersionMismatchReason(result: {
  code?: string | undefined;
  error?: string | undefined;
}): string | null {
  if (result.code !== OCPP_VERSION_MISMATCH) return null;
  return result.error ?? 'The station OCPP version cannot take this command';
}
