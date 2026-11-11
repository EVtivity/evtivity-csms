// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { drivers, invoices } from '@evtivity/database';
import { defineListSort, sortablePersonName } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/fleets/:id/invoices` (`api/routes.md`, "List sorting").
 * Billed To sorts member invoices by the driver's name; fleet invoices (no driver shown)
 * sort last. The list joins `drivers` on the invoice's driver.
 */
export const fleetInvoiceListSort = defineListSort(
  {
    invoiceNumber: invoices.invoiceNumber,
    periodStart: invoices.periodStart,
    billedTo: sql`case when ${invoices.memberBilled} then ${sortablePersonName(drivers.firstName, drivers.lastName)} end`,
    status: invoices.status,
    issuedAt: invoices.issuedAt,
    dueAt: invoices.dueAt,
    sentAt: invoices.sentAt,
    total: invoices.totalCents,
  },
  {
    tieBreaker: invoices.id,
    defaultOrder: [desc(invoices.createdAt), desc(invoices.id)],
  },
);
