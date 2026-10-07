// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Load management allocation strategies: the single list for the database enum
// (`load_allocation_strategy`), the API validation, the allocation service and the
// CSMS. Browser-safe, because the CSMS imports it.
export const LOAD_ALLOCATION_STRATEGIES = ['equal_share', 'priority_based'] as const;

export type LoadAllocationStrategy = (typeof LOAD_ALLOCATION_STRATEGIES)[number];
