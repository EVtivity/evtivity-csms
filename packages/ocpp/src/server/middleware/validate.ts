// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppErrorCode } from '../../protocol/error-codes.js';
import { OcppError } from '@evtivity/lib';
import { actionSchemaEntry } from '../ocpp-registry.js';
import type { AjvError } from '../ocpp-registry.js';
import { ocpp201RequestBoundErrors, toOcpp201Reply } from '../ocpp201/to-ocpp201.js';
import type { Middleware } from './pipeline.js';

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
  // The registry of the connection's protocol (1.6, 2.0.1, else 2.1). An
  // action it does not define (including Object.prototype names such as
  // `constructor`) reaches the router, which answers NotImplemented.
  const entry = actionSchemaEntry(ctx.protocolVersion, ctx.action);

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

  if (ctx.protocolVersion === 'ocpp2.0.1') {
    const boundErrors = ocpp201RequestBoundErrors(ctx.action, ctx.payload);
    if (boundErrors.length > 0) {
      throw new OcppError(OcppErrorCode.PropertyConstraintViolation, 'Request validation failed', {
        errors: boundErrors,
      });
    }
  }

  await next();

  if (ctx.response != null) {
    // A 2.0.1 station gets the 2.1 handler's reply without what 2.0.1 does not
    // define, then checked strictly against the 2.0.1 schema below.
    if (ctx.protocolVersion === 'ocpp2.0.1') {
      ctx.response = toOcpp201Reply(ctx.action, ctx.response);
    }
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
