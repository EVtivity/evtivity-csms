// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Default saved card of the first demo driver, the driver of the seeded
 * re-bill sessions. The `approve` scenario in the simulated method id makes
 * every hold, capture and re-bill on it succeed, so the re-bill demo does not
 * fail at the simulated provider's random failure rate. The other demo
 * drivers keep scenario-less ids (`pm_sim_<n>`), which fail at random.
 */
export const REBILL_DEMO_METHOD_ID = 'pm_sim_approve_4242_000001';
