// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Adds the demo AI insights (seed-ai-insights.ts) to an existing demo
// database without the full seed: `npm run seed:ai-insights -w
// @evtivity/database`. Reads DATABASE_URL, SETTINGS_ENCRYPTION_KEY and
// INITIAL_ADMIN_EMAIL like seed.ts. Every write is ON CONFLICT DO NOTHING
// behind fixed ids, so a rerun adds nothing and nothing is deleted.

import { client } from './config.js';
import { getCompanyCurrency } from './lib/system-settings.js';
import { seedAiInsightsDemo } from './seed-ai-insights.js';
import { seedReservationInsightsDemo } from './seed-reservation-insights.js';

const adminEmail = process.env['INITIAL_ADMIN_EMAIL'] ?? 'admin@evtivity.local';

try {
  const [admin] = await client<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${adminEmail}
  `;
  const [driver] = await client<{ id: string }[]>`
    SELECT id FROM drivers WHERE is_active ORDER BY created_at, id LIMIT 1 OFFSET 2
  `;
  if (driver == null) throw new Error('No active driver: run the demo seed first');
  const created = await seedAiInsightsDemo(client, {
    now: new Date(),
    currency: await getCompanyCurrency(),
    driverId: driver.id,
    actorUserId: admin?.id ?? null,
    subjectSecret: process.env['SETTINGS_ENCRYPTION_KEY'] ?? '',
  });
  console.log(`${String(created)} AI insights created.`);
  // The reservation insights live on the demo station CS-0993 (index 990 of the demo seed).
  const [station] = await client<{ id: string }[]>`
    SELECT id FROM charging_stations WHERE station_id = 'CS-0993'
  `;
  const [reservationDriver] = await client<{ id: string }[]>`
    SELECT id FROM drivers WHERE is_active ORDER BY created_at, id LIMIT 1 OFFSET 1
  `;
  if (station != null && reservationDriver != null) {
    const [evse] = await client<{ id: string }[]>`
      SELECT id FROM evses WHERE station_id = ${station.id} ORDER BY evse_id LIMIT 1
    `;
    const reservations = await seedReservationInsightsDemo(client, {
      stationId: station.id,
      evseId: evse?.id ?? null,
      driverId: reservationDriver.id,
      currency: await getCompanyCurrency(),
      now: new Date(),
    });
    console.log(`${String(reservations)} reservation insights created.`);
  }
} finally {
  await client.end();
}
