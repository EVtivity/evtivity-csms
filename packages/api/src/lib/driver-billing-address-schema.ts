// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { DRIVER_BILLING_ADDRESS_MAX_LENGTHS as MAX } from '../services/driver-billing.service.js';

// Request and response schemas of the driver billing address, shared by the
// operator route (/v1/drivers/:id/billing-address) and the portal routes
// (/v1/portal/driver/billing-address, /v1/portal/auth/me).

export const driverBillingAddressItem = z
  .object({
    billingName: z
      .string()
      .nullable()
      .describe('Name on the invoice; null prints the first and last name'),
    billingStreet: z.string().nullable().describe('Street address'),
    billingCity: z.string().nullable().describe('City'),
    billingState: z.string().nullable().describe('State or region'),
    billingZip: z.string().nullable().describe('Postal code'),
    billingCountry: z.string().nullable().describe('Country'),
  })
  .passthrough();

const optionalText = (max: number, what: string) =>
  z.string().max(max).nullable().optional().describe(`${what}; null or blank clears it`);

export const driverBillingAddressBody = z.object({
  billingName: optionalText(MAX.billingName, 'Name on the invoice (empty: first and last name)'),
  billingStreet: optionalText(MAX.billingStreet, 'Street address'),
  billingCity: optionalText(MAX.billingCity, 'City'),
  billingState: optionalText(MAX.billingState, 'State or region'),
  billingZip: optionalText(MAX.billingZip, 'Postal code'),
  billingCountry: optionalText(MAX.billingCountry, 'Country'),
});
