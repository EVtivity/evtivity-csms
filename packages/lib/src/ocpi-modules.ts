// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI modules the OCPI server can pull from a partner's sender endpoint on an
// `ocpi_sync` request. The API validates the manual sync route against this list
// (it cannot import @evtivity/ocpi); the OCPI module registry must match it.
export const OCPI_PULL_MODULES = ['locations', 'tariffs', 'cdrs'] as const;

export type OcpiPullModule = (typeof OCPI_PULL_MODULES)[number];
