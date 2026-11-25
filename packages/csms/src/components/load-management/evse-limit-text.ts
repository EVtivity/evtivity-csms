// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import { formatNumberUpTo } from '@/lib/formatting';

/** One charging EVSE limit of the load management reply. */
export interface EvseLimitView {
  evseNumber: number;
  unitId: string | null;
  kind: 'ac' | 'dc';
  limitA: number | null;
  limitKw: number;
  paused: boolean;
  /** The EVSE reports SmartChargingCtrlr.ACPhaseSwitchingSupported true (OCPP 2.x). */
  phaseSwitchingSupported?: boolean;
  /** The EVSE phase the single-phase car is sent to charge on; null: none. */
  phaseToUse?: number | null;
}

/** "EVSE 2: 16 A, on phase 3", "EVSE 1: 16 A, phase switching" or "EVSE 1: 7.4 kW". */
export function evseLimitText(limit: EvseLimitView, t: TFunction): string {
  const value = limit.paused
    ? t('loadManagement.unitBudgetPaused')
    : limit.limitA != null
      ? `${formatNumberUpTo(limit.limitA, 1)} A`
      : `${formatNumberUpTo(limit.limitKw, 2)} kW`;
  const text = t('loadManagement.unitBudgetEvseLimit', { evse: limit.evseNumber, limit: value });
  if (limit.phaseToUse != null) {
    return t('loadManagement.evseLimitPhaseToUse', { text, phase: limit.phaseToUse });
  }
  if (limit.phaseSwitchingSupported === true) {
    return t('loadManagement.evseLimitPhaseSwitching', { text });
  }
  return text;
}
