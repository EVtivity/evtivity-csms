// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import { closePassedDepartures } from '@evtivity/services/departure-notice.service';
import { ALL_TEMPLATES_DIRS } from '@evtivity/services/template-dirs';
import { config } from '../lib/config.js';

/**
 * Cron `departure-close` (every minute): completes departures whose time
 * passed with outcome met, short or no vehicle, and sends the missed notice
 * once per departure. Runs while fleet charging is off too.
 */
export async function departureCloseHandler(log: Logger, now: Date = new Date()): Promise<void> {
  const result = await closePassedDepartures({
    log,
    csmsUrl: config.CSMS_URL,
    templatesDirs: ALL_TEMPLATES_DIRS,
    now: () => now,
  });
  if (result.completed > 0) log.info(result, 'Passed departures completed');
}
