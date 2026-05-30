// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppError } from '@evtivity/lib';
import { OcppErrorCode } from '../../protocol/error-codes.js';
import type { HandlerContext, NextFunction } from './pipeline.js';

/**
 * Per OCPP 2.1 spec B02.FR.02: when the CSMS responds with Pending or Rejected
 * to BootNotification, it MUST respond to all CALL messages other than
 * BootNotification with a SecurityError CALLERROR until a BootNotification is
 * Accepted.
 *
 * The spec scopes this rule to the Pending/Rejected case. It does NOT mandate
 * rejection when bootStatus is null (no BootNotification has arrived yet).
 * Real stations commonly send Heartbeat or StatusNotification in parallel
 * with BootNotification because of WebSocket frame queuing — extending the
 * rule to null breaks interop with widely-deployed non-compliant firmware
 * without buying any spec compliance the OCTT actually asserts.
 *
 * Null is therefore allowed to pass through. The downstream handler decides
 * whether to act on the message; in practice the BootNotification CALL is
 * almost always the next frame and the session reaches 'Accepted' immediately
 * after.
 */
export function createBootGuardMiddleware() {
  return async (ctx: HandlerContext, next: NextFunction): Promise<void> => {
    const { bootStatus } = ctx.session;

    if (ctx.action === 'BootNotification') {
      await next();
      return;
    }

    if (bootStatus !== 'Accepted' && bootStatus !== null) {
      ctx.logger.info(
        { stationId: ctx.stationId, action: ctx.action, bootStatus },
        'Rejecting message: BootNotification was not Accepted',
      );
      throw new OcppError(OcppErrorCode.SecurityError, 'Station boot status is not Accepted');
    }

    await next();
  };
}
