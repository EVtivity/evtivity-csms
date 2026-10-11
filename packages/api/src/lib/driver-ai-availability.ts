// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getAiSettings } from '@evtivity/database';
import { createLogger } from '@evtivity/lib';
import { isDriverAiUsable } from '@evtivity/services/driver-ai-config';
import { config as apiConfig } from './config.js';

const logger = createLogger('driver-ai-availability');

export interface DriverAiAvailability {
  /** `driverAi.enabled` and a provider with a key: new cases offer the AI analysis. */
  available: boolean;
  /** `ai.rateLimit.driverPerMinute`. */
  perMinute: number;
}

/**
 * Whether new driver cases offer the AI analysis (plan v0.1.45, section
 * 2.10), from the cached AI settings. Fails closed: a read error means no AI
 * (P9), so a case then goes straight to operators.
 */
export async function readDriverAiAvailability(): Promise<DriverAiAvailability> {
  try {
    const settings = await getAiSettings();
    return {
      available: isDriverAiUsable(settings, apiConfig.NODE_ENV === 'development'),
      perMinute: settings.limits.driverPerMinute,
    };
  } catch (err) {
    logger.warn({ err }, 'Driver AI settings could not be read, the AI analysis is off');
    return { available: false, perMinute: 0 };
  }
}
