// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

export function zodSchema(schema: ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;
}
