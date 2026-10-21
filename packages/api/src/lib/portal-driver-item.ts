// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

/** The driver of a portal sign-in reply (login, MFA verify, passkey sign-in). */
export const portalDriverItem = z
  .object({
    id: z.string(),
    firstName: z.string().max(100).nullable(),
    lastName: z.string().max(100).nullable(),
    email: z.string().email().max(255).nullable(),
    phone: z.string().max(50).nullable(),
    language: z.string().max(10).nullable(),
    timezone: z.string().max(50).nullable(),
    themePreference: z.enum(['light', 'dark']),
    distanceUnit: z.enum(['miles', 'km']),
    priceDisplay: z
      .enum(['gross', 'net'])
      .nullable()
      .describe(
        'Whether prices are shown including (gross) or excluding (net) tax. Null follows the company setting.',
      ),
    isActive: z.boolean(),
    emailVerified: z.boolean(),
    createdAt: z.coerce.date(),
  })
  .passthrough();
