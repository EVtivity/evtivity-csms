// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppError } from '@evtivity/lib';
import { OcppErrorCode } from '../../protocol/error-codes.js';
import type { HandlerContext, NextFunction } from './pipeline.js';

/**
 * Per OCPP 2.1 spec (B02.FR.02): When the CSMS responds with Pending or Rejected
 * to BootNotification, it MUST respond to all messages other than BootNotification
 * with a SecurityError CALLERROR.
 *
 * The boot status is tracked on the session by the BootNotification handler.
 * Null means no boot has occurred yet (also reject).
 */
export function createBootGuardMiddleware() {
  return async (ctx: HandlerContext, next: NextFunction): Promise<void> => {
    const { bootStatus } = ctx.session;

    // Allow BootNotification through regardless of boot status
    if (ctx.action === 'BootNotification') {
      await next();
      return;
    }

    // Reject non-BootNotification when station has not been accepted
    if (bootStatus !== 'Accepted' && bootStatus !== null) {
      ctx.logger.info(
        { stationId: ctx.stationId, action: ctx.action, bootStatus },
        'Rejecting message: station boot not accepted',
      );
      throw new OcppError(OcppErrorCode.SecurityError, 'Station boot status is not Accepted');
    }

    await next();
  };
}
