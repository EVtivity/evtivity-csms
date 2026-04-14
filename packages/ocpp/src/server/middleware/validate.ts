// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppErrorCode } from '../../protocol/error-codes.js';
import { OcppError } from '@evtivity/lib';
import { ActionRegistry as Registry21 } from '../../generated/v2_1/registry.js';
import { ActionRegistry as Registry16 } from '../../generated/v1_6/registry.js';
import type { Middleware } from './pipeline.js';

type RegistryEntry = {
  validateRequest: (data: unknown) => boolean;
  validateResponse: (data: unknown) => boolean;
} & {
  validateRequest: { errors?: unknown[] | null };
  validateResponse: { errors?: unknown[] | null };
};

export const validateMiddleware: Middleware = async (ctx, next) => {
  const registry = ctx.protocolVersion === 'ocpp1.6' ? Registry16 : Registry21;
  const entry = (registry as Record<string, RegistryEntry | undefined>)[ctx.action];

  if (entry == null) {
    await next();
    return;
  }

  const valid = entry.validateRequest(ctx.payload);
  if (!valid) {
    const errors = entry.validateRequest.errors ?? [];
    throw new OcppError(OcppErrorCode.FormatViolation, 'Request validation failed', { errors });
  }

  await next();

  if (ctx.response != null) {
    const responseValid = entry.validateResponse(ctx.response);
    if (!responseValid) {
      ctx.logger.error(
        { action: ctx.action, errors: entry.validateResponse.errors },
        'Response validation failed',
      );
    }
  }
};
