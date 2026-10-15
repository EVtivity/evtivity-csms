// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppError } from '@evtivity/lib';
import { OcppErrorCode } from '../../protocol/error-codes.js';
import type { HandlerContext, NextFunction } from './pipeline.js';

/**
 * Per OCPP 2.1 spec B01.FR.10 (and the Pending-specific B02.FR.09): once a
 * BootNotificationResponse with a status other than Accepted has been sent, the
 * CSMS SHALL respond with a SecurityError CALLERROR to any CALL other than
 * BootNotificationRequest (or one triggered by TriggerMessage / GetBaseReport /
 * GetReport) until a BootNotification is Accepted. B02.FR.02 is the mirror
 * Charging-Station obligation ("SHALL NOT send" those CALLs), not the CSMS rule.
 *
 * The spec scopes this to the Pending/Rejected case (its precondition is that a
 * non-Accepted BootNotificationResponse was already sent). It does NOT mandate
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
 *
 * Exception: a station awaiting operator approval (onboarding status pending
 * under the approval-required registration policy) starts its connection at
 * 'Pending' (OcppServer.handleConnection), since its BootNotification would be
 * answered Pending. Until a BootNotification is Accepted it gets SecurityError
 * here, even when it never sends one.
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
