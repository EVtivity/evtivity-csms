// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI 2.2.1-specific types
// These are types that exist only in 2.2.1 or differ from 2.3.0

// In 2.2.1, enum values are strictly defined (closed enums)
// No additional type extensions needed for 2.2.1 as the base types in ocpi.ts
// already cover the 2.2.1 specification

export type Ocpi221Version = '2.2.1';

export const OCPI_221_MODULES = [
  'credentials',
  'locations',
  'sessions',
  'cdrs',
  'tariffs',
  'tokens',
  'commands',
  'chargingprofiles',
  'hubclientinfo',
] as const;
