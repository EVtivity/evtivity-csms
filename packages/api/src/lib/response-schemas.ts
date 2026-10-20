// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import type { ZodRawShape, ZodTypeAny } from 'zod';
import { zodSchema } from './zod-schema.js';
import { ERROR_MESSAGES, type ErrorCode } from './error-codes.generated.js';

const errorSchema = z
  .object({
    error: z
      .string()
      .describe('Human-readable error message suitable for logging or fallback display'),
    code: z
      .string()
      .describe(
        'Stable machine-readable error code (UPPER_SNAKE_CASE). Catalog: https://evtivity.com/api-reference/error-codes',
      ),
  })
  .passthrough();

const successSchema = z
  .object({
    success: z.literal(true),
  })
  .passthrough();

/**
 * Generic error response. Prefer `errorWith()` so docs show a specific
 * status description and the exact set of codes the endpoint can return.
 */
export const errorResponse = zodSchema(errorSchema);

export const successResponse = zodSchema(successSchema);

/**
 * Per-status error response with a description and an enumerated list of
 * codes the endpoint actually returns at that status. Renders in OpenAPI
 * as a labeled response (e.g. "Station not found") with `code` shown as
 * an enum so consumers can see exactly which codes to expect and look them
 * up in the public catalog at https://evtivity.com/api-reference/error-codes.
 */
export function errorWith(
  description: string,
  codes: readonly [ErrorCode, ...ErrorCode[]],
  extraFields: ZodRawShape = {},
): Record<string, unknown> {
  const codeEnum =
    codes.length === 1
      ? z.literal(codes[0]).describe('Error code returned at this status')
      : z
          .enum(codes as unknown as [ErrorCode, ...ErrorCode[]])
          .describe('Error code returned at this status');

  // Surface the actual default English message(s) so docs readers see a
  // realistic example instead of a generic placeholder. For a single code
  // this is the canonical message; for multiple codes we list each
  // code -> message so consumers know what string to expect per branch.
  const errorDesc =
    codes.length === 1
      ? `Default: "${ERROR_MESSAGES[codes[0]]}"`
      : `Default depends on code:\n${codes.map((c) => `  - ${c}: "${ERROR_MESSAGES[c]}"`).join('\n')}`;

  return zodSchema(
    z
      .object({
        error: z.string().describe(errorDesc),
        code: codeEnum,
        ...extraFields,
      })
      .passthrough()
      .describe(description),
  );
}

export function paginatedResponse(itemSchema: ZodTypeAny): Record<string, unknown> {
  return zodSchema(
    z
      .object({
        data: z.array(itemSchema),
        total: z.number(),
      })
      .passthrough(),
  );
}

export function itemResponse(schema: ZodTypeAny): Record<string, unknown> {
  if ('passthrough' in schema && typeof schema.passthrough === 'function') {
    return zodSchema((schema as z.ZodObject<z.ZodRawShape>).passthrough());
  }
  return zodSchema(schema);
}

export function arrayResponse(schema: ZodTypeAny): Record<string, unknown> {
  return zodSchema(z.array(schema));
}
