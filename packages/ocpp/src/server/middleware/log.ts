// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Middleware } from './pipeline.js';

export const logMiddleware: Middleware = async (ctx, next) => {
  const start = Date.now();

  ctx.logger.info(
    { messageId: ctx.messageId, action: ctx.action, stationId: ctx.stationId },
    'Processing CALL',
  );

  await next();

  const duration = Date.now() - start;
  ctx.logger.info({ messageId: ctx.messageId, action: ctx.action, duration }, 'Processed CALL');
};
