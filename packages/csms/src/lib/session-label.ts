// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { formatDateTime } from '@/lib/timezone';

export interface SessionLabelParts {
  stationOcppId?: string | null | undefined;
  startedAt?: string | Date | null | undefined;
  transactionId?: string | null | undefined;
}

/**
 * The readable label of a charging session for link text and pickers, never the
 * internal session id: "CS-001, Nov 11, 2026, 10:00 AM", with ", #<transaction>"
 * when the station transaction id is given. Falls back to "Session" when nothing
 * readable is known.
 */
export function sessionLabel(t: TFunction, parts: SessionLabelParts, timezone: string): string {
  const pieces: string[] = [];
  if (parts.stationOcppId != null && parts.stationOcppId !== '') pieces.push(parts.stationOcppId);
  if (parts.startedAt != null) pieces.push(formatDateTime(parts.startedAt, timezone));
  if (parts.transactionId != null && parts.transactionId !== '') {
    pieces.push(`#${parts.transactionId}`);
  }
  return pieces.length > 0 ? pieces.join(', ') : t('common.sessionFallback');
}
