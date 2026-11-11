// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { ocpiPartners, ocpiTariffMappings } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/**
 * The sortable columns of `GET /v1/ocpi/tariff-mappings` (`api/routes.md`, "List sorting").
 * A mapping for all partners has no partner name and sorts last.
 */
export const ocpiTariffMappingListSort = defineListSort(
  {
    ocpiTariffId: ocpiTariffMappings.ocpiTariffId,
    partner: ocpiPartners.name,
    updatedAt: ocpiTariffMappings.updatedAt,
  },
  {
    tieBreaker: ocpiTariffMappings.id,
    defaultOrder: [desc(ocpiTariffMappings.createdAt), desc(ocpiTariffMappings.id)],
  },
);
