// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Adds the member invoice demo (seed-member-invoices.ts) to an existing demo
// database without the full seed: `npm run seed:member-invoices -w
// @evtivity/database`. Reads DATABASE_URL like seed.ts. Every write is
// ON CONFLICT DO NOTHING behind fixed ids, so a rerun adds nothing and nothing
// is deleted.

import { client } from './config.js';
import { getCompanyCurrency } from './lib/system-settings.js';
import { seedMemberInvoiceDemo } from './seed-member-invoices.js';

try {
  // The first demo station (CS-0003, index 0 of the demo seed), where the
  // fleet billing demo sessions ran too.
  const [station] = await client<{ id: string }[]>`
    SELECT id FROM charging_stations WHERE station_id = 'CS-0003'
  `;
  if (station == null) throw new Error('No demo station CS-0003: run the demo seed first');
  const [evse] = await client<{ id: string }[]>`
    SELECT id FROM evses WHERE station_id = ${station.id} ORDER BY evse_id LIMIT 1
  `;
  const created = await seedMemberInvoiceDemo(client, {
    stationId: station.id,
    evseId: evse?.id ?? null,
    currency: await getCompanyCurrency(),
    now: new Date(),
  });
  console.log(`${String(created)} member sessions created.`);
} finally {
  await client.end();
}
