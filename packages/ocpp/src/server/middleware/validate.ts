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
  validateRequest: { errors?: AjvError[] | null };
  validateResponse: { errors?: AjvError[] | null };
};

interface AjvError {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
}

// Maps AJV error keyword to the OCPP 2.1 Part 4 error code class for that
// constraint kind. OCTT conformance suites assert on the specific code.
function ocppErrorCodeForAjvErrors(errors: AjvError[]): OcppErrorCode {
  const first = errors[0];
  if (first == null) return OcppErrorCode.FormatViolation;
  switch (first.keyword) {
    case 'required':
    case 'minItems':
    case 'maxItems':
    case 'minProperties':
    case 'maxProperties':
      return OcppErrorCode.OccurrenceConstraintViolation;
    case 'type':
      return OcppErrorCode.TypeConstraintViolation;
    case 'enum':
    case 'pattern':
    case 'format':
    case 'maxLength':
    case 'minLength':
    case 'maximum':
    case 'minimum':
    case 'exclusiveMaximum':
    case 'exclusiveMinimum':
    case 'multipleOf':
    case 'additionalProperties':
    case 'const':
      return OcppErrorCode.PropertyConstraintViolation;
    default:
      return OcppErrorCode.FormatViolation;
  }
}

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
    throw new OcppError(ocppErrorCodeForAjvErrors(errors), 'Request validation failed', {
      errors,
    });
  }

  await next();

  if (ctx.response != null) {
    const responseValid = entry.validateResponse(ctx.response);
    if (!responseValid) {
      const errors = entry.validateResponse.errors ?? [];
      ctx.logger.error(
        { action: ctx.action, errors },
        'Response validation failed: handler produced a response that does not match the schema',
      );
      throw new OcppError(
        OcppErrorCode.InternalError,
        'CSMS produced an invalid response payload',
        { errors },
      );
    }
  }
};
