// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Email of the driver the OCTT conformance runner creates for a run. Its
 * tokens and pricing group belong to the run alone: the chaos simulator must
 * not start sessions with them, or a demo station's session keeps the run's
 * driver and tariff referenced and the run's cleanup fails.
 */
export const OCTT_TEST_DRIVER_EMAIL = 'octt-test@evtivity.local';
