// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Energy threshold of the OCTT pricing group's bulk tariff, in kWh. The
 * runner provisions it (runner.ts provisionTestTariff); TC_I_109 expects it
 * as a minEnergy condition and TC_I_111 crosses it to make the CSMS switch
 * the session's tariff. High enough that no other test's meter values reach it.
 */
export const OCTT_THRESHOLD_KWH = 500;
