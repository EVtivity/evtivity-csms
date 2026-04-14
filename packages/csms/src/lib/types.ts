// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Shared interfaces used across multiple CSMS frontend files.
 *
 * Add interfaces here when they appear in 3+ files with identical or near-identical shapes.
 * Prefer importing from this module over defining local copies.
 */

/** Pricing group as returned by GET /v1/pricing-groups. */
export interface PricingGroup {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  tariffCount: number;
  createdAt: string;
  updatedAt: string;
}
