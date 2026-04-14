// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const ID_LENGTH = 12;

export function prefixedId(prefix: string): z.ZodString {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_[a-z0-9]{${String(ID_LENGTH)}}$`),
      `Invalid ${prefix}_ ID format`,
    );
}

export const ID_PARAMS = {
  roleId: prefixedId('rol'),
  userId: prefixedId('usr'),
  siteId: prefixedId('sit'),
  vendorId: prefixedId('vnd'),
  stationId: prefixedId('sta'),
  evseId: prefixedId('evs'),
  connectorId: prefixedId('con'),
  sessionId: prefixedId('ses'),
  driverId: prefixedId('drv'),
  driverTokenId: prefixedId('dtk'),
  vehicleId: prefixedId('veh'),
  fleetId: prefixedId('flt'),
  tariffId: prefixedId('trf'),
  pricingGroupId: prefixedId('pgr'),
  reservationId: prefixedId('rsv'),
  supportCaseId: prefixedId('cas'),
  invoiceId: prefixedId('inv'),
  ocpiPartnerId: prefixedId('opr'),
  reportId: prefixedId('rpt'),
  panelId: prefixedId('pnl'),
  circuitId: prefixedId('cir'),
} as const;
