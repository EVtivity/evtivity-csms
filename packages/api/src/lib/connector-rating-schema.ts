// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import {
  CONNECTOR_CURRENT_AMPS_DECIMALS,
  CONNECTOR_POWER_KW_DECIMALS,
  CONNECTOR_RATING_MIN,
  hasAtMostDecimals,
} from '@evtivity/lib/connector-power';

/**
 * Connector maximum power in kW as an operator enters it: at least 0.1, at most
 * 2 decimals (3.68, 7.4, 11.5). The decimal check is a refinement, so it runs
 * in `parseZodRequest` (the JSON Schema keeps the minimum only: Ajv's
 * `multipleOf` misreads binary fractions such as 7.4).
 */
export function connectorPowerKwSchema(min = CONNECTOR_RATING_MIN) {
  return z
    .number()
    .min(min)
    .refine((v) => hasAtMostDecimals(v, CONNECTOR_POWER_KW_DECIMALS), {
      message: `Maximum power takes at most ${String(CONNECTOR_POWER_KW_DECIMALS)} decimals`,
    });
}

/** Connector maximum current in A: at least 0.1, at most 1 decimal (31.5). */
export function connectorCurrentAmpsSchema(min = CONNECTOR_RATING_MIN) {
  return z
    .number()
    .min(min)
    .refine((v) => hasAtMostDecimals(v, CONNECTOR_CURRENT_AMPS_DECIMALS), {
      message: `Maximum current takes at most ${String(CONNECTOR_CURRENT_AMPS_DECIMALS)} decimal`,
    });
}
