// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { invoices } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/invoices` (`api/routes.md`, "List sorting"). */
export const invoiceListSort = defineListSort(
  {
    invoiceNumber: invoices.invoiceNumber,
    kind: invoices.kind,
    status: invoices.status,
    issuedAt: invoices.issuedAt,
    dueAt: invoices.dueAt,
    total: invoices.totalCents,
  },
  {
    tieBreaker: invoices.id,
    defaultOrder: [desc(invoices.createdAt), desc(invoices.id)],
  },
);
