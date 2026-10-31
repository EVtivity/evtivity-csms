// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Adds the Plug and Charge, free vend, SIM and payment terminal demo (seed-demo-features.ts) to
// an existing demo database without the full seed: `npm run
// seed:demo-features -w @evtivity/database`. Reads DATABASE_URL like seed.ts.
// Every row has a fixed id or a natural key and is inserted ON CONFLICT DO
// NOTHING, so a rerun adds nothing and nothing is deleted. Turns pnc.enabled
// and sim.hologram.enabled on.

import { client } from './config.js';
import { getCompanyCurrency, getCompanyTaxBasis } from './lib/system-settings.js';
import { seedDemoFeatures } from './seed-demo-features.js';

try {
  const [station] = await client<{ id: string }[]>`
    SELECT id FROM charging_stations WHERE station_id = 'CS-0003'
  `;
  if (station == null) throw new Error('No demo station CS-0003: run the demo seed first');
  const adminEmail = process.env['INITIAL_ADMIN_EMAIL'] ?? 'admin@evtivity.local';
  const [admin] = await client<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${adminEmail}
  `;
  const counts = await seedDemoFeatures(client, {
    now: new Date(),
    currency: await getCompanyCurrency(),
    taxBasis: await getCompanyTaxBasis(),
    actorUserId: admin?.id ?? null,
  });
  console.log(
    `${String(counts.pncSessions)} Plug and Charge sessions, ${String(counts.freeVendSessions)} free vend sessions, ${String(counts.sims)} SIMs, ${String(counts.terminalPayments)} terminal payments and ${String(counts.layoutStations)} site layout demo stations and ${String(counts.driverAvatars)} demo driver avatars created.`,
  );
} finally {
  await client.end();
}
