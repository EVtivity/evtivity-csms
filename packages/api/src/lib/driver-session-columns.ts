// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { drivers } from '@evtivity/database';

/** The driver fields a sign-in reply and GET /v1/portal/auth/me return. */
export const driverSessionColumns = {
  id: drivers.id,
  firstName: drivers.firstName,
  lastName: drivers.lastName,
  email: drivers.email,
  phone: drivers.phone,
  language: drivers.language,
  timezone: drivers.timezone,
  themePreference: drivers.themePreference,
  distanceUnit: drivers.distanceUnit,
  priceDisplay: drivers.priceDisplay,
  isActive: drivers.isActive,
  emailVerified: drivers.emailVerified,
  createdAt: drivers.createdAt,
};
