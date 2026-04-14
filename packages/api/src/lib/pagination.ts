// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1).describe('Page number (1-based)'),
  limit: z.coerce.number().int().min(1).max(100).default(10).describe('Items per page (max 100)'),
  search: z.string().optional().describe('Search filter'),
});

export type PaginationParams = z.infer<typeof paginationQuery>;

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
}
