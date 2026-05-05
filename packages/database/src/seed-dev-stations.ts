// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// docker-build.sh dev fixture (npm run db:seed:dev). Runs after `db:seed` and
// adds 1 site + 3 stations (IOCHARGER-001 OCPP 2.1, CS-0001 OCPP 2.1, CS-1001
// OCPP 1.6) so a fresh Docker stack has something to exercise without the full
// 2000-station demo dataset. Idempotent; no-op when those station IDs already
// exist (e.g. when SEED_DEMO=true already created them).

import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db, client } from './config.js';
import {
  sites,
  vendors,
  chargingStations,
  evses,
  connectors,
  cssStations,
  cssEvses,
  drivers,
  chargingProfileTemplates,
} from './schema/index.js';

console.log('Seeding dev stations...');

const [site] = await db
  .insert(sites)
  .values({
    name: 'Dev Site',
    address: '1 Main St',
    city: 'Saratoga Springs',
    state: 'NY',
    postalCode: '12866',
    country: 'United States',
    timezone: 'America/New_York',
  })
  .onConflictDoNothing({ target: sites.name })
  .returning({ id: sites.id });

const siteId =
  site?.id ??
  (await db.select({ id: sites.id }).from(sites).where(eq(sites.name, 'Dev Site')))[0]?.id;
if (siteId == null) throw new Error('Failed to upsert dev site');

// Look up first to avoid creating duplicate vendor rows on repeat runs.
// vendors.name has no unique constraint, so onConflictDoNothing() cannot
// catch the conflict and a plain insert would always succeed.
const existingIoVendor = await db
  .select({ id: vendors.id })
  .from(vendors)
  .where(eq(vendors.name, 'IoCharger'))
  .limit(1);

let ioVendorId: string | undefined = existingIoVendor[0]?.id;
if (ioVendorId == null) {
  const [ioVendor] = await db
    .insert(vendors)
    .values({ name: 'IoCharger' })
    .returning({ id: vendors.id });
  ioVendorId = ioVendor?.id;
}

const stationDefs = [
  {
    stationId: 'IOCHARGER-001',
    vendorId: ioVendorId,
    model: 'IOCAH10-50',
    serialNumber: 'A10E231922830',
    ocppProtocol: 'ocpp2.1',
    isSimulator: false,
    connector: { type: 'Type1', power: '7.68', amps: 32 },
  },
  {
    stationId: 'IOCHARGER-002',
    vendorId: ioVendorId,
    model: 'IOCAH10-50',
    serialNumber: 'A10E231922831',
    ocppProtocol: 'ocpp2.1',
    isSimulator: false,
    connector: { type: 'Type1', power: '7.68', amps: 32 },
  },
  {
    stationId: 'CS-0001',
    vendorId: null,
    model: 'DCFC-150',
    serialNumber: 'SN-2026-0001',
    ocppProtocol: 'ocpp2.1',
    isSimulator: true,
    connector: { type: 'CCS2', power: '150', amps: 375 },
  },
  {
    stationId: 'CS-1001',
    vendorId: ioVendorId,
    model: 'DCFC-150',
    serialNumber: 'SN-2026-1001',
    ocppProtocol: 'ocpp1.6',
    isSimulator: true,
    connector: { type: 'CCS2', power: '150', amps: 375 },
  },
];

let createdCount = 0;
for (const def of stationDefs) {
  const [inserted] = await db
    .insert(chargingStations)
    .values({
      stationId: def.stationId,
      siteId,
      vendorId: def.vendorId,
      model: def.model,
      serialNumber: def.serialNumber,
      firmwareVersion: '1.0.0',
      availability: 'available',
      onboardingStatus: 'accepted',
      isOnline: false,
      isSimulator: def.isSimulator,
      securityProfile: 0,
      ocppProtocol: def.ocppProtocol,
    })
    .onConflictDoNothing({ target: chargingStations.stationId })
    .returning({ id: chargingStations.id });

  if (inserted == null) continue;

  const [evse] = await db
    .insert(evses)
    .values({ stationId: inserted.id, evseId: 1 })
    .returning({ id: evses.id });
  if (evse == null) throw new Error(`Failed to create EVSE for ${def.stationId}`);

  await db.insert(connectors).values({
    evseId: evse.id,
    connectorId: 1,
    status: 'unavailable',
    connectorType: def.connector.type,
    maxPowerKw: def.connector.power,
    maxCurrentAmps: def.connector.amps,
  });

  // Provision CSS runtime rows so SimulatorManager's 5s poll boots the
  // simulator without waiting for a chaos-orchestrator restart. Skipped for
  // non-simulator stations like IOCHARGER-001.
  if (def.isSimulator) {
    const [cssStation] = await db
      .insert(cssStations)
      .values({
        stationId: def.stationId,
        targetUrl: 'ws://ocpp:7103',
        sourceType: 'chaos',
        enabled: true,
      })
      .onConflictDoNothing({ target: cssStations.stationId })
      .returning({ id: cssStations.id });

    if (cssStation != null) {
      await db.insert(cssEvses).values({
        cssStationId: cssStation.id,
        evseId: 1,
        connectorId: 1,
        connectorType: 'ac_type2',
        maxPowerW: 22000,
        phases: 3,
        voltage: 230,
      });
    }
  }

  createdCount++;
}

console.log(`  ${String(createdCount)} dev stations created (skipped any that already existed).`);

// Dev driver: matches the credentials baked into docker-build.sh's PORTAL_LOGIN
// auto-login (driver@evtivity.local / driver123). Required because the
// SEED_DEMO=false path of seed.ts only creates the admin user; without this
// row the portal login page returns INVALID_CREDENTIALS on auto-submit.
// drivers.email has no DB-level unique constraint, so check-then-insert.
const existingDriver = await db
  .select({ id: drivers.id })
  .from(drivers)
  .where(eq(drivers.email, 'driver@evtivity.local'))
  .limit(1);
if (existingDriver.length === 0) {
  const driverPasswordHash = await argon2.hash('driver123');
  await db.insert(drivers).values({
    firstName: 'Dev',
    lastName: 'Driver',
    email: 'driver@evtivity.local',
    passwordHash: driverPasswordHash,
    registrationSource: 'portal',
    emailVerified: true,
    isActive: true,
  });
  console.log('  Dev driver created (driver@evtivity.local / driver123).');
} else {
  console.log('  Dev driver already exists.');
}

// Smart charging template: restrict IoCharger stations to off-peak window
// (23:00-03:00 EST). TxDefaultProfile applies to all sessions on matching
// stations; the operator pushes from the Smart Charging UI once stations
// are online. Anchor at midnight EST (05:00 UTC) so offsets line up with
// wall-clock time-of-day (canonical form for Daily Recurring).
if (ioVendorId != null) {
  const templateName = 'IoCharger Off-Peak (11pm-3am EST)';
  const existingTemplate = await db
    .select({ id: chargingProfileTemplates.id })
    .from(chargingProfileTemplates)
    .where(eq(chargingProfileTemplates.name, templateName))
    .limit(1);
  if (existingTemplate.length === 0) {
    await db.insert(chargingProfileTemplates).values({
      name: templateName,
      description: 'Allow charging only between 23:00 and 03:00 EST. Targets IoCharger vendor.',
      ocppVersion: '2.1',
      profileId: 200,
      profilePurpose: 'TxDefaultProfile',
      profileKind: 'Recurring',
      recurrencyKind: 'Daily',
      stackLevel: 0,
      evseId: 0,
      chargingRateUnit: 'A',
      schedulePeriods: [
        { startPeriod: 0, limit: 32, numberPhases: 1 },
        { startPeriod: 10800, limit: 0, numberPhases: 1 },
        { startPeriod: 82800, limit: 32, numberPhases: 1 },
      ],
      startSchedule: new Date('2026-01-05T05:00:00Z'),
      targetFilter: { vendorId: ioVendorId },
    });
    console.log(`  Created smart charging template: ${templateName}`);
  } else {
    console.log(`  Smart charging template already exists: ${templateName}`);
  }
}

console.log('Dev station seed complete.');
await client.end();
