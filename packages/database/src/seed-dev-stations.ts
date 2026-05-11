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
async function ensureVendor(name: string): Promise<string> {
  const existing = await db
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.name, name))
    .limit(1);
  if (existing[0] != null) return existing[0].id;
  const [created] = await db.insert(vendors).values({ name }).returning({ id: vendors.id });
  if (created == null) throw new Error(`Failed to create vendor: ${name}`);
  return created.id;
}

const ioVendorId = await ensureVendor('IoCharger');
const evtivityVendorId = await ensureVendor('EVtivity');

const stationDefs = [
  {
    stationId: 'IOCHARGER-001',
    vendorId: ioVendorId,
    model: 'IOCAH10-50',
    serialNumber: 'A10E231922830',
    ocppProtocol: 'ocpp1.6',
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
    vendorId: evtivityVendorId,
    model: 'DCFC-150',
    serialNumber: 'SN-2026-0001',
    ocppProtocol: 'ocpp1.6',
    isSimulator: true,
    connector: { type: 'CCS2', power: '150', amps: 375 },
  },
  {
    stationId: 'CS-0002',
    vendorId: evtivityVendorId,
    model: 'DCFC-150',
    serialNumber: 'SN-2026-0002',
    ocppProtocol: 'ocpp2.1',
    isSimulator: true,
    connector: { type: 'CCS2', power: '150', amps: 375 },
  },
];

let createdCount = 0;
for (const def of stationDefs) {
  const [insertedRow] = await db
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

  // If the station already exists, fetch its id so we can still refresh the
  // owned config template below. Station fields themselves are preserved
  // (an operator may have edited them).
  let inserted: { id: string } | undefined = insertedRow;
  if (inserted == null) {
    const [existing] = await db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(eq(chargingStations.stationId, def.stationId))
      .limit(1);
    if (existing == null) continue;
    inserted = existing;
  }

  if (def.vendorId !== ioVendorId) {
    const tplName = `${def.stationId} - Configurations`;
    const tplOcppVersion = def.ocppProtocol === 'ocpp1.6' ? '1.6' : '2.1';
    const tplFilter = {
      stationId: inserted.id,
      siteId,
      vendorId: def.vendorId,
      model: def.model,
    };
    await db
      .insert(configTemplates)
      .values({
        name: tplName,
        description: `Auto generated. ${def.stationId} configurations (OCPP ${tplOcppVersion})`,
        ocppVersion: tplOcppVersion,
        variables: [],
        stationId: inserted.id,
        targetFilter: tplFilter,
      })
      .onConflictDoUpdate({
        target: configTemplates.stationId,
        set: {
          name: tplName,
          description: `Auto generated. ${def.stationId} configurations (OCPP ${tplOcppVersion})`,
          ocppVersion: tplOcppVersion,
          targetFilter: tplFilter,
          updatedAt: new Date(),
        },
      });
  }

  // EVSE / connector / CSS rows only get created on first insert. The unique
  // constraints below would otherwise throw for an already-seeded station.
  // Skip ahead to the next station so the script remains idempotent.
  if (insertedRow == null) continue;

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
// Stripe call at seed time. Card 4242 4242 4242 4242 is the canonical Stripe
// test card (Visa, last4 4242, always succeeds in test mode). Real Stripe
// API calls (PaymentIntent, capture) will reject these placeholder IDs, but
// the portal UI and reservation flow rely only on the row's existence.
const existingPaymentMethod = await db
  .select({ id: driverPaymentMethods.id })
  .from(driverPaymentMethods)
  .where(eq(driverPaymentMethods.driverId, devDriverId))
  .limit(1);
if (existingPaymentMethod.length === 0) {
  await db.insert(driverPaymentMethods).values({
    driverId: devDriverId,
    stripeCustomerId: 'cus_dev_driver',
    stripePaymentMethodId: 'pm_dev_driver_visa_4242',
    cardBrand: 'visa',
    cardLast4: '4242',
    isDefault: true,
  });
  console.log('  Dev driver payment method created (Visa **** 4242).');
} else {
  console.log('  Dev driver payment method already exists.');
}

// Smart charging template: restrict IoCharger stations to off-peak window
// (23:00-03:00 EST). TxDefaultProfile applies to all sessions on matching
// stations; the operator pushes from the Smart Charging UI once stations
// are online. Anchor at midnight EST (05:00 UTC) so offsets line up with
// wall-clock time-of-day (canonical form for Daily Recurring).
{
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

// IOCHARGER station-specific config templates: linked to the station via
// the new stationId FK so the template is owned by (and cascade-deleted with)
// the station. The seeded variables cover IoCharger vendor extensions.
{
  const [io2Station] = await db
    .select({
      id: chargingStations.id,
      siteId: chargingStations.siteId,
      vendorId: chargingStations.vendorId,
      model: chargingStations.model,
    })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, 'IOCHARGER-002'))
    .limit(1);
  const [io1Station] = await db
    .select({
      id: chargingStations.id,
      siteId: chargingStations.siteId,
      vendorId: chargingStations.vendorId,
      model: chargingStations.model,
    })
    .from(chargingStations)
    .where(eq(chargingStations.stationId, 'IOCHARGER-001'))
    .limit(1);

  const ioConfigTemplateName = 'IOCHARGER-002 - Configurations';
  const ioConfigTemplateValues = {
    name: ioConfigTemplateName,
    description: 'Auto generated. IOCHARGER-002 configurations (OCPP 2.1)',
    ocppVersion: '2.1' as const,
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
      { component: 'TariffCostCtrlr', variable: 'Enabled', value: 'false' },
      {
        component: 'TariffCostCtrlr',
        variable: 'TariffFallbackMessage',
        value: 'Welcome to EVtivity Charging. Scan barcode to start.',
      },
    ],
  };
  if (io2Station != null) {
    const ioFilter = {
      stationId: io2Station.id,
      ...(io2Station.siteId != null ? { siteId: io2Station.siteId } : {}),
      ...(io2Station.vendorId != null ? { vendorId: io2Station.vendorId } : {}),
      ...(io2Station.model != null ? { model: io2Station.model } : {}),
    };
    await db
      .insert(configTemplates)
      .values({ ...ioConfigTemplateValues, stationId: io2Station.id, targetFilter: ioFilter })
      .onConflictDoUpdate({
        target: configTemplates.stationId,
        set: {
          name: ioConfigTemplateValues.name,
          description: ioConfigTemplateValues.description,
          ocppVersion: ioConfigTemplateValues.ocppVersion,
          variables: ioConfigTemplateValues.variables,
          targetFilter: ioFilter,
          updatedAt: new Date(),
        },
      });
    console.log(`  Upserted config template: ${ioConfigTemplateName}`);
  }

  // OCPP 1.6 variant for IOCHARGER-001 (vendor-specific keys with empty
  // component, since 1.6 has no component model).
  const io16ConfigTemplateName = 'IOCHARGER-001 - Configurations';
  const io16ConfigTemplateValues = {
    name: io16ConfigTemplateName,
    description: 'Auto generated. IOCHARGER-001 configurations (OCPP 1.6)',
    ocppVersion: '1.6' as const,
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
      { component: '', variable: 'TariffCostCtrlr.Enabled', value: 'false' },
      {
        component: '',
        variable: 'TariffCostCtrlr.TariffFallbackMessage',
        value: 'Welcome to EVtivity Charging. Scan barcode to start.',
      },
    ],
  };
  if (io1Station != null) {
    const io16Filter = {
      stationId: io1Station.id,
      ...(io1Station.siteId != null ? { siteId: io1Station.siteId } : {}),
      ...(io1Station.vendorId != null ? { vendorId: io1Station.vendorId } : {}),
      ...(io1Station.model != null ? { model: io1Station.model } : {}),
    };
    await db
      .insert(configTemplates)
      .values({ ...io16ConfigTemplateValues, stationId: io1Station.id, targetFilter: io16Filter })
      .onConflictDoUpdate({
        target: configTemplates.stationId,
        set: {
          name: io16ConfigTemplateValues.name,
          description: io16ConfigTemplateValues.description,
          ocppVersion: io16ConfigTemplateValues.ocppVersion,
          variables: io16ConfigTemplateValues.variables,
          targetFilter: io16Filter,
          updatedAt: new Date(),
        },
      });
    console.log(`  Upserted config template: ${io16ConfigTemplateName}`);
  }
}

console.log('Dev station seed complete.');
await client.end();
