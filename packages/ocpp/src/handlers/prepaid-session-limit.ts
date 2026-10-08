// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { client } from '@evtivity/database';

/**
 * The credit a prepaid session may spend: the cost ceiling the Started
 * projection reserved for it (`linkPrepaidToken`, the balance minus what the
 * token's other active and unsettled sessions reserve). The 2.1
 * TransactionEventResponse sends it as `transactionLimit.maxCost`
 * (C17.FR.03). Returns null when the session of this transaction at the
 * station is not linked to the token yet or has no ceiling.
 */
export async function prepaidSessionCeilingCents(
  stationId: string,
  transactionId: string,
  tokenId: string,
): Promise<number | null> {
  const [row] = await client`
    SELECT cs.cost_ceiling_cents
    FROM charging_sessions cs
    JOIN charging_stations st ON st.id = cs.station_id
    WHERE st.station_id = ${stationId}
      AND cs.transaction_id = ${transactionId}
      AND cs.token_id = ${tokenId}
    LIMIT 1
  `;
  const ceiling = row?.['cost_ceiling_cents'] as number | string | null | undefined;
  return ceiling != null ? Number(ceiling) : null;
}
