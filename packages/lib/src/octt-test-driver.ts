// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Email of the driver the OCTT conformance runner creates for a run. Its
 * tokens and pricing group belong to the run alone: the chaos simulator must
 * not start sessions with them, or a demo station's session keeps the run's
 * driver and tariff referenced and the run's cleanup fails.
 */
export const OCTT_TEST_DRIVER_EMAIL = 'octt-test@evtivity.local';

/**
 * Settings row holding the settings a running CSMS conformance run changed and
 * their values before it, written before each change. A run killed before it
 * restored them leaves the row, and the next run or the worker sweep puts the
 * values back. Server-managed: the generic settings routes never show or write it.
 */
export const OCTT_PENDING_RESTORE_SETTING_KEY = 'octt.pendingRestore';
