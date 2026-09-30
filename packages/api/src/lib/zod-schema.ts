// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { ValidationError } from '@evtivity/lib';

export function zodSchema(schema: ZodTypeAny): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    target: 'openApi3',
    $refStrategy: 'none',
  });
  allowNullInNullableEnums(jsonSchema);
  return jsonSchema;
}

/**
 * zod-to-json-schema renders `z.enum([...]).nullable()` as
 * `{ type: 'string', enum: [...], nullable: true }`. Ajv applies `enum`
 * independently of `nullable`, so a request that sends `null` fails
 * validation even though the zod schema allows it. OpenAPI 3.0 requires null
 * to be listed in `enum` for a nullable enum, so add it there.
 */
function allowNullInNullableEnums(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) allowNullInNullableEnums(item);
    return;
  }
  if (node == null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const values = record['enum'];
  if (record['nullable'] === true && Array.isArray(values) && !values.includes(null)) {
    values.push(null);
  }
  for (const value of Object.values(record)) allowNullInNullableEnums(value);
}

/**
 * zodSchema() hands Fastify a JSON Schema, and zod-to-json-schema drops
 * `.refine()` and `.superRefine()`, so Ajv never runs them. Routes whose request
 * schema carries refinements call this with the Ajv-validated value to enforce
 * them. Throws a 400 VALIDATION_ERROR with the first failing rule's message.
 */
export function assertZodRefinements(schema: ZodTypeAny, value: unknown): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ValidationError(issue?.message ?? 'Validation failed', result.error.issues);
  }
}
