// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { db, chargingSessions } from '@evtivity/database';
import { eq } from 'drizzle-orm';
import type { HandlerContext } from '../../server/middleware/pipeline.js';

export async function handleGetTransactionStatus(
  ctx: HandlerContext,
): Promise<Record<string, unknown>> {
  const request = ctx.payload as { transactionId?: string };

  ctx.logger.info(
    { stationId: ctx.stationId, transactionId: request.transactionId },
    'GetTransactionStatus requested',
  );

  if (request.transactionId == null) {
    return { messagesInQueue: false, ongoingIndicator: false };
  }

  const [session] = await db
    .select({ status: chargingSessions.status })
    .from(chargingSessions)
    .where(eq(chargingSessions.transactionId, request.transactionId));

  if (session == null) {
    return { messagesInQueue: false, ongoingIndicator: false };
  }

  return {
    messagesInQueue: false,
    ongoingIndicator: session.status === 'active',
  };
}
