// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// OCPI publishes a pricing group whose tariffs differ by charging type as
// `<mapped id>-AC` and `<mapped id>-DC` (owner decision D-C, 2026-11-13).
// OCPI Tariff `id` is string(36), so such a group's mapped ids hold at most
// 33 characters: refused at the mapping save and at the tariff write that
// would make the group differ by type.

import { and, eq, ne, sql } from 'drizzle-orm';
import { db, ocpiTariffMappings, tariffs } from '@evtivity/database';
import { OCPI_KIND_TARIFF_BASE_ID_MAX } from '@evtivity/lib';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A mapped OCPI tariff id of the group longer than 33 characters, or null. */
export async function ocpiIdTooLongForKinds(tx: Executor, groupId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: ocpiTariffMappings.ocpiTariffId })
    .from(ocpiTariffMappings)
    .where(
      and(
        eq(ocpiTariffMappings.pricingGroupId, groupId),
        sql`length(${ocpiTariffMappings.ocpiTariffId}) > ${OCPI_KIND_TARIFF_BASE_ID_MAX}`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** True when the group holds an active AC or DC tariff (it publishes per kind). */
export async function groupHasChargingTypeTariffs(tx: Executor, groupId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: tariffs.id })
    .from(tariffs)
    .where(
      and(
        eq(tariffs.pricingGroupId, groupId),
        eq(tariffs.isActive, true),
        ne(tariffs.chargingType, 'both'),
      ),
    )
    .limit(1);
  return row != null;
}
