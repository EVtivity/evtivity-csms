// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

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
