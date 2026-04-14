// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql } from 'drizzle-orm';
import { db, client, sites } from './index.js';

async function seedSnapshots(): Promise<void> {
  const allSites = await db.select({ id: sites.id, name: sites.name }).from(sites);
  console.log(`Found ${String(allSites.length)} sites`);

  const today = new Date();
  const days = 14;

  for (const site of allSites) {
    for (let i = 1; i <= days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0] ?? '';

      // Generate realistic-looking data with slight daily variation
      const seed = i + site.id.charCodeAt(0);
      const jitter = (base: number, pct: number): number =>
        Math.round(base * (1 + Math.sin(seed * i * 0.7) * pct));

      const totalStations = jitter(20, 0.05);
      const onlineStations = Math.max(1, totalStations - Math.floor(Math.sin(seed * i) * 2 + 1));
      const onlinePercent = Math.round((onlineStations / totalStations) * 1000) / 10;
      const uptimePercent = Math.round((95 + Math.sin(seed * i * 0.3) * 4) * 100) / 100;
      const daySessions = jitter(50, 0.3);
      const totalSessions = 5000 + daySessions * i;
      const dayEnergyWh = jitter(150000, 0.25);
      const totalEnergyWh = 15000000 + dayEnergyWh * i;
      const dayRevenueCents = jitter(25000, 0.3);
      const totalRevenueCents = 2500000 + dayRevenueCents * i;
      const dayTransactions = jitter(45, 0.3);
      const totalTransactions = 4500 + dayTransactions * i;
      const totalPorts = totalStations * 2;
      const stationsBelowThreshold = Math.max(0, Math.floor(Math.sin(seed * i * 0.5) * 3));
      const avgRevPerSession =
        totalSessions > 0 ? Math.round(totalRevenueCents / totalSessions) : 0;
      const avgPingLatencyMs = Math.round((3 + Math.sin(seed * i * 0.9) * 2) * 100) / 100;
      const pingSuccessRate = Math.round((98 + Math.sin(seed * i * 0.4) * 2) * 10) / 10;

      await db.execute(sql`
        INSERT INTO dashboard_snapshots (
          site_id, snapshot_date, total_stations, online_stations, online_percent,
          uptime_percent, active_sessions, total_energy_wh, day_energy_wh,
          total_sessions, day_sessions, connected_stations,
          total_revenue_cents, day_revenue_cents, avg_revenue_cents_per_session,
          total_transactions, day_transactions, total_ports, stations_below_threshold,
          avg_ping_latency_ms, ping_success_rate,
          created_at
        ) VALUES (
          ${site.id}, ${dateStr}::date, ${totalStations}, ${onlineStations}, ${onlinePercent},
          ${uptimePercent}, ${Math.floor(Math.random() * 5)}, ${totalEnergyWh}, ${dayEnergyWh},
          ${totalSessions}, ${daySessions}, ${onlineStations},
          ${totalRevenueCents}, ${dayRevenueCents}, ${avgRevPerSession},
          ${totalTransactions}, ${dayTransactions}, ${totalPorts}, ${stationsBelowThreshold},
          ${avgPingLatencyMs}, ${pingSuccessRate},
          now()
        )
        ON CONFLICT (site_id, snapshot_date) DO UPDATE SET
          total_stations = EXCLUDED.total_stations,
          online_stations = EXCLUDED.online_stations,
          online_percent = EXCLUDED.online_percent,
          uptime_percent = EXCLUDED.uptime_percent,
          active_sessions = EXCLUDED.active_sessions,
          total_energy_wh = EXCLUDED.total_energy_wh,
          day_energy_wh = EXCLUDED.day_energy_wh,
          total_sessions = EXCLUDED.total_sessions,
          day_sessions = EXCLUDED.day_sessions,
          connected_stations = EXCLUDED.connected_stations,
          total_revenue_cents = EXCLUDED.total_revenue_cents,
          day_revenue_cents = EXCLUDED.day_revenue_cents,
          avg_revenue_cents_per_session = EXCLUDED.avg_revenue_cents_per_session,
          total_transactions = EXCLUDED.total_transactions,
          day_transactions = EXCLUDED.day_transactions,
          total_ports = EXCLUDED.total_ports,
          stations_below_threshold = EXCLUDED.stations_below_threshold,
          avg_ping_latency_ms = EXCLUDED.avg_ping_latency_ms,
          ping_success_rate = EXCLUDED.ping_success_rate,
          created_at = now()
      `);
    }
    console.log(`Seeded ${String(days)} days for site ${site.name} (${site.id})`);
  }

  console.log('Done seeding dashboard snapshots');
  await client.end();
}

seedSnapshots().catch((err: unknown) => {
  console.error(err);
  client
    .end()
    .then(() => {
      process.exit(1);
    })
    .catch(() => {
      process.exit(1);
    });
});
