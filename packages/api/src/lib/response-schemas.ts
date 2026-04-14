// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { zodSchema } from './zod-schema.js';

const errorSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
  })
  .passthrough();

const successSchema = z
  .object({
    success: z.literal(true),
  })
  .passthrough();

export const errorResponse = zodSchema(errorSchema);

export const successResponse = zodSchema(successSchema);

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
