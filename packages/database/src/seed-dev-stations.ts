// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// docker-build.sh dev fixture (npm run db:seed:dev). Runs after `db:seed` and
// adds 1 site + 4 stations (IOCHARGER-001 / IOCHARGER-002 OCPP 2.1 real,
// CS-0001 OCPP 1.6 simulator, CS-0002 OCPP 2.1 simulator) so a fresh Docker
// stack has something to exercise without the full 2000-station demo dataset.
// Idempotent; no-op when those station IDs already exist (e.g. when
// SEED_DEMO=true already created them).

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
  driverPaymentMethods,
  chargingProfileTemplates,
  configTemplates,
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
    ocppProtocol: 'ocpp1.6',
    isSimulator: true,
    connector: { type: 'CCS2', power: '150', amps: 375 },
  },
  {
    stationId: 'CS-0002',
    vendorId: null,
    model: 'DCFC-150',
    serialNumber: 'SN-2026-0002',
    ocppProtocol: 'ocpp2.1',
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
let devDriverId: string;
if (existingDriver.length === 0) {
  const driverPasswordHash = await argon2.hash('driver123');
  const [created] = await db
    .insert(drivers)
    .values({
      firstName: 'Dev',
      lastName: 'Driver',
      email: 'driver@evtivity.local',
      passwordHash: driverPasswordHash,
      registrationSource: 'portal',
      emailVerified: true,
      isActive: true,
    })
    .returning({ id: drivers.id });
  if (created == null) throw new Error('Failed to create dev driver');
  devDriverId = created.id;
  console.log('  Dev driver created (driver@evtivity.local / driver123).');
} else {
  const found = existingDriver[0];
  if (found == null) throw new Error('Failed to read existing dev driver');
  devDriverId = found.id;
  console.log('  Dev driver already exists.');
}

// Default payment method for the dev driver. Uses Stripe placeholder IDs
// (cus_dev_/pm_dev_) so the row shape is correct without requiring a live
// Stripe call at seed time. Card 4222 2222 2222 2222 is a Stripe test card
// (Visa, last4 2222). Real Stripe API calls (PaymentIntent, capture) will
// reject these placeholder IDs, but the portal UI and reservation flow rely
// only on the row's existence.
const existingPaymentMethod = await db
  .select({ id: driverPaymentMethods.id })
  .from(driverPaymentMethods)
  .where(eq(driverPaymentMethods.driverId, devDriverId))
  .limit(1);
if (existingPaymentMethod.length === 0) {
  await db.insert(driverPaymentMethods).values({
    driverId: devDriverId,
    stripeCustomerId: 'cus_dev_driver',
    stripePaymentMethodId: 'pm_dev_driver_visa_2222',
    cardBrand: 'visa',
    cardLast4: '2222',
    isDefault: true,
  });
  console.log('  Dev driver payment method created (Visa **** 2222).');
} else {
  console.log('  Dev driver payment method already exists.');
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

// Block-all test templates (2.1 + 1.6). Generic — no target filter — so the
// operator can push them to any station to verify zero-power gating.
// stackLevel 7 ensures these win against any other seeded profile (which use
// stack 0/1) without exceeding the typical station max (8).
const blockAllDefs = [
  {
    name: 'Test: Block All Charging (2.1)',
    description: 'Testing template that delivers 0W at all times.',
    ocppVersion: '2.1',
    profileId: 998,
  },
  {
    name: 'Test: Block All Charging (1.6)',
    description: 'Testing template that delivers 0W at all times.',
    ocppVersion: '1.6',
    profileId: 999,
  },
];
for (const def of blockAllDefs) {
  const existing = await db
    .select({ id: chargingProfileTemplates.id })
    .from(chargingProfileTemplates)
    .where(eq(chargingProfileTemplates.name, def.name))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(chargingProfileTemplates).values({
      name: def.name,
      description: def.description,
      ocppVersion: def.ocppVersion,
      profileId: def.profileId,
      profilePurpose: 'TxDefaultProfile',
      profileKind: 'Recurring',
      recurrencyKind: 'Daily',
      stackLevel: 7,
      evseId: 0,
      chargingRateUnit: 'W',
      schedulePeriods: [{ startPeriod: 0, limit: 0 }],
      duration: 86400,
      startSchedule: new Date('2026-01-01T00:00:00Z'),
    });
    console.log(`  Created smart charging template: ${def.name}`);
  } else {
    console.log(`  Smart charging template already exists: ${def.name}`);
  }
}

// IOCHARGER vendor-specific config template: QR code URLs and connector codes
// (SysConfigCtrlr component, OCPP 2.1). Targets the IoCharger vendor so the
// operator can push it to IOCHARGER-001 / IOCHARGER-002 from the Configuration
// Templates UI without picking individual stations.
if (ioVendorId != null) {
  const ioConfigTemplateName = 'IOCHARGER-002 - QR & Connector Code';
  const existingIoConfigTemplate = await db
    .select({ id: configTemplates.id })
    .from(configTemplates)
    .where(eq(configTemplates.name, ioConfigTemplateName))
    .limit(1);
  if (existingIoConfigTemplate.length === 0) {
    await db.insert(configTemplates).values({
      name: ioConfigTemplateName,
      description: 'IoCharger vendor QR code URLs, connector codes, and operator branding.',
      ocppVersion: '2.1',
      variables: [
        {
          component: 'SysConfigCtrlr',
          variable: 'QR0',
          value: 'http://45.47.131.88:7101/charge/IOCHARGER-002/1',
        },
        {
          component: 'SysConfigCtrlr',
          variable: 'QR1',
          value: 'http://45.47.131.88:7101/charge/IOCHARGER-002/1',
        },
        { component: 'SysConfigCtrlr', variable: 'connCode0', value: 'IOCHARGER-002' },
        { component: 'SysConfigCtrlr', variable: 'connCode1', value: 'IOCHARGER-002' },
        { component: 'SecurityCtrlr', variable: 'OrganizationName', value: 'EVtivity' },
      ],
      targetFilter: { siteId, vendorId: ioVendorId },
    });
    console.log(`  Created config template: ${ioConfigTemplateName}`);
  } else {
    console.log(`  Config template already exists: ${ioConfigTemplateName}`);
  }

  // OCPP 1.6 variant for IOCHARGER-001 (vendor-specific keys with empty
  // component, since 1.6 has no component model).
  const io16ConfigTemplateName = 'IOCHARGER-001 - QR & Connector Code';
  const existingIo16ConfigTemplate = await db
    .select({ id: configTemplates.id })
    .from(configTemplates)
    .where(eq(configTemplates.name, io16ConfigTemplateName))
    .limit(1);
  if (existingIo16ConfigTemplate.length === 0) {
    await db.insert(configTemplates).values({
      name: io16ConfigTemplateName,
      description: 'IoCharger vendor QR code URLs and connector codes (OCPP 1.6).',
      ocppVersion: '1.6',
      variables: [
        {
          component: '',
          variable: 'QR0',
          value: 'http://45.47.131.88:7101/charge/IOCHARGER-001/1',
        },
        {
          component: '',
          variable: 'QR1',
          value: 'http://45.47.131.88:7101/charge/IOCHARGER-001/1',
        },
        { component: '', variable: 'connCode0', value: 'IOCHARGER-001' },
        { component: '', variable: 'connCode1', value: 'IOCHARGER-001' },
      ],
      targetFilter: { siteId, vendorId: ioVendorId },
    });
    console.log(`  Created config template: ${io16ConfigTemplateName}`);
  } else {
    console.log(`  Config template already exists: ${io16ConfigTemplateName}`);
  }
}

console.log('Dev station seed complete.');
await client.end();
