// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc, sql } from 'drizzle-orm';
import { paymentTerminals } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/payment-terminals` (`api/routes.md`, "List sorting"). */
export const paymentTerminalListSort = defineListSort(
  {
    // The name the list shows: the label, else the serial number, else the device ID.
    name: sql`coalesce(${paymentTerminals.label}, ${paymentTerminals.serialNumber}, ${paymentTerminals.providerDeviceId})`,
    model: paymentTerminals.model,
    site: sql`(select s.name from sites s where s.id = ${paymentTerminals.siteId})`,
    station: sql`(select cs.station_id from charging_stations cs where cs.id = ${paymentTerminals.stationId})`,
    provider: paymentTerminals.provider,
    status: paymentTerminals.status,
    online: paymentTerminals.online,
  },
  {
    tieBreaker: paymentTerminals.id,
    defaultOrder: [desc(paymentTerminals.createdAt), desc(paymentTerminals.id)],
  },
);
