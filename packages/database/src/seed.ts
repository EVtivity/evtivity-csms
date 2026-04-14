// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, client } from './config.js';
import { sql, eq, and, isNotNull, isNull } from 'drizzle-orm';
import { createId } from './lib/id.js';
import {
  settings,
  sites,
  vendors,
  chargingStations,
  evses,
  connectors,
  roles,
  users,
  pricingGroups,
  tariffs,
  pricingGroupStations,
  pricingGroupFleets,
  pricingGroupSites,
  pricingGroupDrivers,
  pricingHolidays,
  drivers,
  driverTokens,
  vehicles,
  fleets,
  fleetDrivers,
  fleetStations,
  chargingSessions,
  transactionEvents,
  meterValues,
  reservations,
  sitePowerLimits,
  siteLoadManagement,
  panels,
  circuits,
  paymentRecords,
  supportCases,
  supportCaseSessions,
  supportCaseMessages,
  ocpiPartners,
  ocpiPartnerEndpoints,
  ocpiCredentialsTokens,
  pkiCaCertificates,
  stationCertificates,
  driverPaymentMethods,
  notifications,
  firmwareCampaigns,
  firmwareCampaignStations,
  configTemplates,
  configTemplatePushes,
  configTemplatePushStations,
  driverFavoriteStations,
  dashboardSnapshots,
  chargingProfileTemplates,
  carbonIntensityFactors,
  userPermissions,
  userSiteAssignments,
} from './schema/index.js';
import argon2 from 'argon2';
import {
  encryptString,
  calculateCo2AvoidedKg,
  ADMIN_DEFAULT_PERMISSIONS,
  OPERATOR_DEFAULT_PERMISSIONS,
} from '@evtivity/lib';

// Helper data
const US_CITIES = [
  { city: 'San Francisco', state: 'CA', zip: '94105' },
  { city: 'Los Angeles', state: 'CA', zip: '90001' },
  { city: 'San Diego', state: 'CA', zip: '92101' },
  { city: 'San Jose', state: 'CA', zip: '95101' },
  { city: 'Sacramento', state: 'CA', zip: '95814' },
  { city: 'New York', state: 'NY', zip: '10001' },
  { city: 'Brooklyn', state: 'NY', zip: '11201' },
  { city: 'Austin', state: 'TX', zip: '73301' },
  { city: 'Houston', state: 'TX', zip: '77001' },
  { city: 'Dallas', state: 'TX', zip: '75201' },
  { city: 'Seattle', state: 'WA', zip: '98101' },
  { city: 'Portland', state: 'OR', zip: '97201' },
  { city: 'Denver', state: 'CO', zip: '80201' },
  { city: 'Chicago', state: 'IL', zip: '60601' },
  { city: 'Miami', state: 'FL', zip: '33101' },
  { city: 'Atlanta', state: 'GA', zip: '30301' },
  { city: 'Boston', state: 'MA', zip: '02101' },
  { city: 'Phoenix', state: 'AZ', zip: '85001' },
  { city: 'Las Vegas', state: 'NV', zip: '89101' },
  { city: 'Nashville', state: 'TN', zip: '37201' },
];

const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  'San Francisco': { lat: 37.7749, lng: -122.4194 },
  'Los Angeles': { lat: 34.0522, lng: -118.2437 },
  'San Diego': { lat: 32.7157, lng: -117.1611 },
  'San Jose': { lat: 37.3382, lng: -121.8863 },
  Sacramento: { lat: 38.5816, lng: -121.4944 },
  'New York': { lat: 40.7128, lng: -74.006 },
  Brooklyn: { lat: 40.6782, lng: -73.9442 },
  Austin: { lat: 30.2672, lng: -97.7431 },
  Houston: { lat: 29.7604, lng: -95.3698 },
  Dallas: { lat: 32.7767, lng: -96.797 },
  Seattle: { lat: 47.6062, lng: -122.3321 },
  Portland: { lat: 45.5152, lng: -122.6784 },
  Denver: { lat: 39.7392, lng: -104.9903 },
  Chicago: { lat: 41.8781, lng: -87.6298 },
  Miami: { lat: 25.7617, lng: -80.1918 },
  Atlanta: { lat: 33.749, lng: -84.388 },
  Boston: { lat: 42.3601, lng: -71.0589 },
  Phoenix: { lat: 33.4484, lng: -112.074 },
  'Las Vegas': { lat: 36.1699, lng: -115.1398 },
  Nashville: { lat: 36.1627, lng: -86.7816 },
};

// First 5 sites are clustered near Saratoga Springs, NY (43.338131, -73.695849)
const SARATOGA_COORDS: Array<{ lat: number; lng: number }> = [
  { lat: 43.3381, lng: -73.6958 }, // Saratoga Springs center
  { lat: 43.342, lng: -73.701 }, // 0.5 km north
  { lat: 43.335, lng: -73.69 }, // 0.5 km south-east
  { lat: 43.34, lng: -73.685 }, // 1 km east
  { lat: 43.33, lng: -73.7 }, // 1 km south-west
];

const SITE_NAMES = [
  'Main Campus',
  'Downtown Hub',
  'Airport Terminal',
  'Central Mall',
  'University Garage',
  'Tech Park',
  'Hospital Complex',
  'Convention Center',
  'Transit Station',
  'City Hall',
  'Sports Arena',
  'Shopping Center',
  'Office Tower',
  'Residential Complex',
  'Supermarket',
  'Hotel Plaza',
  'Community Center',
  'Library Square',
  'Beach Parking',
  'Mountain Lodge',
];

const VENDOR_NAMES = [
  'IoCharger',
  'ABB',
  'ChargePoint',
  'Tritium',
  'EVBox',
  'Siemens',
  'Schneider Electric',
  'BTC Power',
  'Wallbox',
  'Enel X',
  'Blink Charging',
];

const STATION_MODELS: Array<{ model: string; power: number; type: string; amps: number }> = [
  { model: 'Terra 360', power: 360, type: 'CCS2', amps: 500 },
  { model: 'Terra 184', power: 180, type: 'CCS2', amps: 250 },
  { model: 'CT4000', power: 7, type: 'Type2', amps: 32 },
  { model: 'CP6000', power: 19, type: 'Type2', amps: 32 },
  { model: 'RTM75', power: 75, type: 'CCS2', amps: 200 },
  { model: 'RT50', power: 50, type: 'CHAdeMO', amps: 125 },
  { model: 'BusinessLine', power: 22, type: 'Type2', amps: 32 },
  { model: 'Troniq 50', power: 50, type: 'CCS2', amps: 125 },
  { model: 'Pulsar Plus', power: 11, type: 'Type2', amps: 16 },
  { model: 'JuiceBox', power: 40, type: 'Type1', amps: 48 },
  { model: 'Series 6', power: 150, type: 'CCS2', amps: 350 },
  { model: 'IQ 200', power: 200, type: 'CCS2', amps: 500 },
];

// Simpler models typical of OCPP 1.6-era chargers
const STATION_MODELS_16: Array<{ model: string; power: number; type: string; amps: number }> = [
  { model: 'CT4000 (1.6)', power: 7, type: 'Type2', amps: 32 },
  { model: 'AV-30 (1.6)', power: 22, type: 'Type2', amps: 32 },
  { model: 'QC-50 (1.6)', power: 50, type: 'CHAdeMO', amps: 125 },
  { model: 'DualPlug (1.6)', power: 43, type: 'Type2', amps: 63 },
];

const FIRST_NAMES = [
  'James',
  'Mary',
  'Robert',
  'Patricia',
  'John',
  'Jennifer',
  'Michael',
  'Linda',
  'David',
  'Elizabeth',
  'William',
  'Barbara',
  'Richard',
  'Susan',
  'Joseph',
  'Jessica',
  'Thomas',
  'Sarah',
  'Charles',
  'Karen',
  'Daniel',
  'Lisa',
  'Matthew',
  'Nancy',
  'Anthony',
  'Betty',
  'Mark',
  'Margaret',
  'Donald',
  'Sandra',
  'Steven',
  'Ashley',
  'Paul',
  'Kimberly',
  'Andrew',
  'Emily',
  'Joshua',
  'Donna',
  'Kenneth',
  'Michelle',
  'Kevin',
  'Carol',
  'Brian',
  'Amanda',
  'George',
  'Melissa',
  'Timothy',
  'Deborah',
  'Ronald',
  'Stephanie',
];

const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
  'Walker',
  'Young',
  'Allen',
  'King',
  'Wright',
  'Scott',
  'Torres',
  'Nguyen',
  'Hill',
  'Flores',
  'Green',
  'Adams',
  'Nelson',
  'Baker',
  'Hall',
  'Rivera',
  'Campbell',
  'Mitchell',
  'Carter',
  'Roberts',
];

const EV_MAKES: Array<{ make: string; models: string[] }> = [
  { make: 'Tesla', models: ['Model 3', 'Model Y', 'Model S', 'Model X'] },
  { make: 'Chevrolet', models: ['Bolt EV', 'Bolt EUV', 'Equinox EV'] },
  { make: 'Ford', models: ['Mustang Mach-E', 'F-150 Lightning'] },
  { make: 'Hyundai', models: ['Ioniq 5', 'Ioniq 6', 'Kona Electric'] },
  { make: 'Kia', models: ['EV6', 'EV9', 'Niro EV'] },
  { make: 'BMW', models: ['iX', 'i4', 'i7'] },
  { make: 'Mercedes-Benz', models: ['EQS', 'EQE', 'EQB'] },
  { make: 'Volkswagen', models: ['ID.4', 'ID.Buzz'] },
  { make: 'Rivian', models: ['R1T', 'R1S'] },
  { make: 'Nissan', models: ['Leaf', 'Ariya'] },
];

const FLEET_NAMES = [
  'City Transit Fleet',
  'Corporate Commuter Pool',
  'Delivery Express',
  'Green Taxi Service',
  'Campus Shuttle Fleet',
  'Healthcare Mobile Units',
  'Municipal Services',
  'Rideshare Partners',
  'Logistics East',
  'Logistics West',
  'Airport Shuttle Service',
  'Hotel Guest Fleet',
  'School District Transport',
  'Emergency Response',
  'Executive Car Service',
];

const STATE_TIMEZONES: Record<string, string> = {
  CA: 'America/Los_Angeles',
  WA: 'America/Los_Angeles',
  OR: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  TX: 'America/Chicago',
  IL: 'America/Chicago',
  TN: 'America/Chicago',
  CO: 'America/Denver',
  AZ: 'America/Phoenix',
};

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function at<T>(arr: T[], index: number): T {
  return arr[index % arr.length] as T;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(daysAgo: number): Date {
  const now = Date.now();
  const past = now - daysAgo * 24 * 60 * 60 * 1000;
  return new Date(past + Math.random() * (now - past));
}

function padNum(n: number, digits: number): string {
  return String(n).padStart(digits, '0');
}

const seedDemo = process.env['SEED_DEMO'] === 'true';

async function seed(): Promise<void> {
  console.log(`Seeding database...${seedDemo ? '' : ' (demo data disabled)'}`);

  // Clear existing data (truncate all tables with cascade)
  console.log('  Clearing existing data...');
  const tables = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != 'drizzle_migrations'
  `);
  if (tables.length > 0) {
    const tableNames = tables.map((t) => t.tablename).join(', ');
    await db.execute(sql.raw(`TRUNCATE TABLE ${tableNames} CASCADE`));
  }
  console.log('  Tables cleared.');

  // ------ Settings ------
  // EVtivity logo - green circle with white lightning bolt
  const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" fill="#4ade80"/><path d="M68 20L38 68h22l-6 32 30-48H62l6-32z" fill="white"/></svg>`;
  const logoDataUri = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}`;

  // Load overrides from seed.config.json (gitignored, not committed)
  const seedConfigPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'seed.config.json');
  let seedOverrides: Record<string, unknown> = {};
  if (existsSync(seedConfigPath)) {
    const raw = JSON.parse(readFileSync(seedConfigPath, 'utf-8')) as {
      settings?: Record<string, unknown>;
    };
    seedOverrides = raw.settings ?? {};
    console.log(
      `  Loaded ${String(Object.keys(seedOverrides).length)} setting overrides from seed.config.json`,
    );
  }

  const defaultSettings: Record<string, unknown> = {
    'system.name': 'EVtivity CSMS',
    'system.timezone': 'America/New_York',
    'ocpp.heartbeatInterval': 300,
    'ocpp.meterValueInterval': 60,
    'ocpp.clockAlignedInterval': 60,
    'ocpp.sampledMeasurands':
      'Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import',
    'ocpp.alignedMeasurands':
      'Energy.Active.Import.Register,Power.Active.Import,Voltage,SoC,Current.Import',
    'ocpp.txEndedMeasurands': 'Energy.Active.Import.Register',
    'ocpp.connectionTimeout': 120,
    'ocpp.resetRetries': 3,
    'ocpp.offlineCommandTtlHours': 24,
    'ocpp.registrationPolicy': 'approval-required',
    'security.autoDisableOnCritical': true,
    'pricing.currency': 'USD',
    'pricing.splitBillingEnabled': true,
    'pricing.displayFormat': 'standard',
    'pricing.pushDisplayEnabled': true,
    'notifications.emailEnabled': true,
    'ftp.host': 'ftp',
    'ftp.port': 21,
    'ftp.username': 'evtivity',
    'ftp.password': 'evtivity',
    'ftp.path': '/logs',
    'smtp.host': 'localhost',
    'smtp.port': 1025,
    'smtp.username': '',
    'smtp.password': '',
    'smtp.from': 'noreply@evtivity.local',
    'twilio.accountSid': '',
    'twilio.authToken': '',
    'twilio.fromNumber': '',
    's3.bucket': '',
    's3.region': '',
    's3.accessKeyIdEnc': '',
    's3.secretAccessKeyEnc': '',
    'stripe.secretKeyEnc': '',
    'stripe.publishableKey': '',
    'stripe.currency': 'USD',
    'stripe.preAuthAmountCents': 5000,
    'stripe.platformFeePercent': 0,
    'roaming.enabled': false,
    'pnc.enabled': false,
    'pnc.provider': 'manual',
    'pnc.hubject.baseUrl': '',
    'pnc.hubject.clientId': '',
    'pnc.hubject.clientSecretEnc': '',
    'pnc.hubject.tokenUrl': '',
    'pnc.expirationWarningDays': 30,
    'pnc.expirationCriticalDays': 7,
    'company.name': 'EVtivity',
    'company.currency': 'USD',
    'company.contactEmail': 'contact@evtivity.local',
    'company.supportEmail': 'support@evtivity.local',
    'company.supportPhone': '+1 (555) 123-4567',
    'company.street': '100 Market Street',
    'company.city': 'San Francisco',
    'company.state': 'CA',
    'company.zip': '94105',
    'company.country': 'US',
    'company.logo': logoDataUri,
    'company.favicon': logoDataUri,
    'company.metaDescription': 'EV charging station management',
    'company.metaKeywords': 'EV, charging, OCPP',
    'company.ogImage': '',
    'company.portalUrl': '',
    'company.themeColor': '#2563eb',
    'sustainability.gridEmissionFactor': '0.386',
    'sustainability.evEfficiency': '3.3',
    'sustainability.gasolineEmissionFactor': '8.887',
    'sustainability.avgMpg': '25.4',
    'idling.gracePeriodMinutes': 30,
    'session.staleTimeoutHours': 24,
    'security.recaptcha.enabled': false,
    'security.recaptcha.siteKey': '',
    'security.recaptcha.secretKeyEnc': '',
    'security.recaptcha.threshold': 0.5,
    'security.mfa.emailEnabled': true,
    'security.mfa.totpEnabled': true,
    'security.mfa.smsEnabled': false,
    'reservation.enabled': true,
    'reservation.bufferMinutes': 0,
    'reservation.cancellationWindowMinutes': 0,
    'reservation.cancellationFeeCents': 0,
    'fleet.enabled': true,
    'support.enabled': true,
    'guest.enabled': true,
    'ocpp.commandRetryMaxAttempts': 3,
    'ocpp.commandRetryBaseDelayMs': 1000,
    'ocpp.commandRetryMaxDelayMs': 30000,
    'smartCharging.iso15118Enabled': true,
    'smartCharging.defaultMaxPowerW': 22000,
    'sentry.enabled': false,
    'sentry.dsn': '',
    'sentry.environment': 'production',
    'googleMaps.apiKey': '',
    'googleMaps.defaultLat': '39.8283',
    'googleMaps.defaultLng': '-98.5795',
    'googleMaps.defaultZoom': '4',
    'chatbotAi.enabled': false,
    'chatbotAi.provider': 'anthropic',
    'chatbotAi.apiKeyEnc': '',
    'chatbotAi.model': '',
    'chatbotAi.temperature': '',
    'chatbotAi.topP': '',
    'chatbotAi.topK': '',
    'chatbotAi.systemPrompt': '',
    'supportAi.enabled': true,
    'supportAi.provider': '',
    'supportAi.apiKeyEnc': '',
    'supportAi.model': '',
    'supportAi.temperature': '',
    'supportAi.topP': '',
    'supportAi.topK': '',
    'supportAi.systemPrompt': '',
    'supportAi.tone': 'professional',
    'sso.enabled': false,
    'sso.provider': '',
    'sso.entryPoint': '',
    'sso.issuer': 'evtivity-csms',
    'sso.certEnc': '',
    'sso.autoProvision': false,
    'sso.defaultRoleId': '',
    'sso.attributeMapping': '{"email":"email","firstName":"firstName","lastName":"lastName"}',
  };

  // Config file uses plaintext key names (no Enc suffix). Map them to DB key names.
  const encryptedKeyMap: Record<string, string> = {
    's3.accessKeyId': 's3.accessKeyIdEnc',
    's3.secretAccessKey': 's3.secretAccessKeyEnc',
    'stripe.secretKey': 'stripe.secretKeyEnc',
    'security.recaptcha.secretKey': 'security.recaptcha.secretKeyEnc',
    'pnc.hubject.clientSecret': 'pnc.hubject.clientSecretEnc',
    'chatbotAi.apiKey': 'chatbotAi.apiKeyEnc',
    'supportAi.apiKey': 'supportAi.apiKeyEnc',
    'sso.cert': 'sso.certEnc',
  };

  // Remap config file keys to their Enc DB counterparts
  const remappedOverrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(seedOverrides)) {
    const dbKey = encryptedKeyMap[key] ?? key;
    remappedOverrides[dbKey] = value;
  }

  // Merge: config file overrides win over defaults
  const mergedSettings = { ...defaultSettings, ...remappedOverrides };

  // Auto-encrypt keys ending in "Enc" when they have a non-empty plaintext value
  const encryptionKey = process.env['SETTINGS_ENCRYPTION_KEY'] ?? '';
  const settingsRows = Object.entries(mergedSettings).map(([key, value]) => {
    if (key.endsWith('Enc') && typeof value === 'string' && value !== '' && encryptionKey !== '') {
      return { key, value: encryptString(value, encryptionKey) };
    }
    return { key, value };
  });

  await db
    .insert(settings)
    .values(settingsRows)
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`EXCLUDED.value`, updatedAt: new Date() },
    });
  console.log(`  ${String(settingsRows.length)} settings created.`);

  if (!seedDemo) {
    // When SEED_DEMO=false, only create roles, admin user, and permissions, then exit
    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash('admin123');

    const [adminRole] = await db
      .insert(roles)
      .values({
        name: 'admin',
        description: 'Full system access',
        permissions: JSON.stringify(['*']),
      })
      .onConflictDoUpdate({
        target: roles.name,
        set: { permissions: JSON.stringify(['*']), updatedAt: new Date() },
      })
      .returning({ id: roles.id });
    await db
      .insert(roles)
      .values({
        name: 'operator',
        description: 'Operational access',
        permissions: JSON.stringify(OPERATOR_DEFAULT_PERMISSIONS),
      })
      .onConflictDoUpdate({
        target: roles.name,
        set: { permissions: JSON.stringify(OPERATOR_DEFAULT_PERMISSIONS), updatedAt: new Date() },
      });
    console.log('  2 roles created.');

    const [adminUser] = await db
      .insert(users)

      .values({
        email: 'admin@evtivity.local',
        passwordHash,
        firstName: 'Admin',
        lastName: 'User',
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        roleId: adminRole!.id,
        hasAllSiteAccess: true,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { passwordHash: sql`EXCLUDED.password_hash`, updatedAt: new Date() },
      })
      .returning({ id: users.id });
    console.log('  1 admin user created (admin@evtivity.local / admin123).');

    const permRows = ADMIN_DEFAULT_PERMISSIONS.map((perm) => ({
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      userId: adminUser!.id,
      permission: perm,
    }));
    await db.insert(userPermissions).values(permRows).onConflictDoNothing();
    console.log(`  ${String(permRows.length)} admin permissions created.`);

    console.log('Seed complete (SEED_DEMO=false).');
    await client.end();
    return;
  }

  // ------ Sites (20) ------
  // First 5 sites override to Saratoga Springs, NY area; rest use city-based coords
  const siteJitter = () => (Math.random() - 0.5) * 0.02; // ~1km offset
  const siteRows = SITE_NAMES.map((name, i) => {
    const loc = at(US_CITIES, i);
    const isSaratoga = i < 5;
    let lat: number;
    let lng: number;
    if (isSaratoga) {
      const coords = at(SARATOGA_COORDS, i);
      lat = coords.lat;
      lng = coords.lng;
    } else {
      const cityCoords = CITY_COORDS[loc.city];
      lat = cityCoords != null ? cityCoords.lat + siteJitter() : 43.338 + siteJitter();
      lng = cityCoords != null ? cityCoords.lng + siteJitter() : -73.696 + siteJitter();
    }
    const HOURS_OPTIONS = [
      'Mon-Fri 6:00 AM - 10:00 PM, Sat-Sun 8:00 AM - 8:00 PM',
      '24/7',
      'Mon-Sun 5:00 AM - 11:00 PM',
      'Mon-Fri 7:00 AM - 9:00 PM',
      'Mon-Sat 6:00 AM - 12:00 AM, Sun 8:00 AM - 10:00 PM',
      null,
    ];
    return {
      name,
      address: `${String(randomInt(100, 9999))} ${pick(['Main St', 'Oak Ave', 'Park Blvd', 'Market St', 'Broadway', 'First Ave', 'Elm Dr', 'Cedar Ln'])}`,
      city: isSaratoga ? 'Saratoga Springs' : loc.city,
      state: isSaratoga ? 'NY' : loc.state,
      postalCode: isSaratoga ? '12866' : loc.zip,
      country: 'US',
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
      timezone: isSaratoga
        ? 'America/New_York'
        : (STATE_TIMEZONES[loc.state] ?? 'America/New_York'),
      hoursOfOperation: at(HOURS_OPTIONS, i % HOURS_OPTIONS.length),
    };
  });
  const createdSites = await db.insert(sites).values(siteRows).returning({ id: sites.id });
  console.log(`  ${String(createdSites.length)} sites created.`);

  // ------ Vendors (10) ------
  const vendorRows = VENDOR_NAMES.map((name) => ({ name }));
  const createdVendors = await db.insert(vendors).values(vendorRows).returning({ id: vendors.id });
  console.log(`  ${String(createdVendors.length)} vendors created.`);

  // ------ Charging Stations (2000) ------
  // Stations 1-1000 (indices 0-999): OCPP 2.1
  // Stations 1001-2000 (indices 1000-1999): OCPP 1.6
  const stationStatuses: Array<'available' | 'unavailable' | 'faulted'> = [
    'available',
    'available',
    'available',
    'unavailable',
    'faulted',
  ];
  // Hash default password for SP1/SP2 stations (matches simulator default STATION_PASSWORD=password)
  const stationPasswordHash = await argon2.hash('password');
  // Track Saratoga Springs site IDs for station-level coordinate assignment
  const saratogaSiteIds = new Set(createdSites.slice(0, 5).map((s) => s.id));
  const saratogaSiteCoords = new Map<string, { lat: number; lng: number }>();
  for (let si = 0; si < 5; si++) {
    const site = at(createdSites, si);
    const coords = at(SARATOGA_COORDS, si);
    saratogaSiteCoords.set(site.id, coords);
  }

  const stationModels: Array<{ model: string; power: number; type: string; amps: number }> = [];
  const stationJitter = () => (Math.random() - 0.5) * 0.004; // ~200m offset
  const stationRows = Array.from({ length: 2000 }, (_, i) => {
    const is16 = i >= 1000;
    const siteRef = i === 0 ? at(createdSites, 0) : pick(createdSites);
    const vendorRef = pick(createdVendors);
    const modelInfo = is16 ? pick(STATION_MODELS_16) : pick(STATION_MODELS);
    stationModels.push(modelInfo);
    const availability = pick(stationStatuses);
    // Simulator stations start offline; the CSS process sets them online when it connects.
    const isOnline = false;
    // Vary load priority: ~15% high (8-10), ~15% low (1-3), rest default (5)
    let loadPriority = 5;
    if (i % 7 === 0) loadPriority = randomInt(8, 10);
    else if (i % 7 === 1) loadPriority = randomInt(1, 3);
    // 2.1 stations: SP0 (1-200), SP1 (201-900), SP2 (901-950), SP3 (951-1000)
    // 1.6 stations: SP0 (1001-1500), SP1 (1501-2000)
    let securityProfile = 1;
    let passwordHash: string | null = stationPasswordHash;
    if (is16) {
      // 1.6 stations: SP0 for indices 1000-1499, SP1 for indices 1500-1999
      if (i < 1500) {
        securityProfile = 0;
        passwordHash = null;
      } else {
        securityProfile = 1;
      }
    } else {
      // 2.1 stations: SP0 for indices 0-199, SP1 for 200-899, SP2 for 900-949, SP3 for 950-999
      if (i < 200) {
        securityProfile = 0;
        passwordHash = null;
      } else if (i >= 900 && i < 950) {
        securityProfile = 2;
      } else if (i >= 950) {
        securityProfile = 3;
        passwordHash = null;
      }
    }
    // Add station-level coords for stations at Saratoga Springs sites (~200m jitter)
    const isSaratogaSite = saratogaSiteIds.has(siteRef.id);
    const siteCoords = saratogaSiteCoords.get(siteRef.id);
    return {
      stationId: i === 0 ? 'IOCHARGER-001' : `CS-${padNum(i + 1, 4)}`,
      siteId: siteRef.id,
      vendorId: i === 0 ? (createdVendors[0]?.id ?? vendorRef.id) : vendorRef.id,
      model: i === 0 ? 'IOCAH10-50' : modelInfo.model,
      serialNumber:
        i === 0 ? 'A10E231922830' : `SN-${String(2024 + Math.floor(i / 100))}-${padNum(i + 1, 4)}`,
      firmwareVersion: `${String(randomInt(1, 3))}.${String(randomInt(0, 9))}.${String(randomInt(0, 20))}`,
      iccid: `8901${padNum(randomInt(10, 99), 2)}${padNum(i + 1, 13)}`.slice(0, 20),
      imsi: `${String(randomInt(310, 316))}${padNum(randomInt(10, 99), 2)}${padNum(i + 1, 10)}`.slice(
        0,
        15,
      ),
      availability,
      onboardingStatus: 'accepted' as const,
      isOnline,
      lastHeartbeat: null,
      loadPriority,
      securityProfile,
      ocppProtocol: is16 ? 'ocpp1.6' : 'ocpp2.1',
      basicAuthPasswordHash: passwordHash,
      isSimulator: i !== 0,
      latitude:
        isSaratogaSite && siteCoords != null
          ? (siteCoords.lat + stationJitter()).toFixed(6)
          : undefined,
      longitude:
        isSaratogaSite && siteCoords != null
          ? (siteCoords.lng + stationJitter()).toFixed(6)
          : undefined,
    };
  });
  const createdStations = await db
    .insert(chargingStations)
    .values(stationRows)
    .returning({ id: chargingStations.id });
  console.log(`  ${String(createdStations.length)} charging stations created.`);

  // ------ Site Power Limits (first 8 sites) ------
  const strategies: Array<'equal_share' | 'priority_based'> = ['equal_share', 'priority_based'];
  const powerLimitRows = createdSites.slice(0, 8).map((site, i) => {
    // Count stations assigned to this site
    const stationCount = stationRows.filter((s) => s.siteId === site.id).length;
    // Average connector power across all models (~80 kW rough avg), scale by 0.7 to create contention
    const avgConnectorKw = 80;
    const maxPowerKw = Math.round(stationCount * avgConnectorKw * 0.7);
    return {
      siteId: site.id,
      maxPowerKw: String(maxPowerKw),
      safetyMarginKw: String(randomInt(5, 15)),
      strategy: strategies[i % 2] as 'equal_share' | 'priority_based',
      isEnabled: i < 5,
    };
  });
  await db.insert(sitePowerLimits).values(powerLimitRows);
  console.log(
    `  ${String(powerLimitRows.length)} site power limits created (${String(powerLimitRows.filter((r) => r.isEnabled).length)} enabled).`,
  );

  // ------ Site Load Management (hierarchical model, mirrors sitePowerLimits) ------
  const loadMgmtRows = createdSites.slice(0, 8).map((site, i) => ({
    siteId: site.id,
    strategy: strategies[i % 2] as 'equal_share' | 'priority_based',
    isEnabled: i < 5,
  }));
  await db.insert(siteLoadManagement).values(loadMgmtRows);
  console.log(`  ${String(loadMgmtRows.length)} site load management configs created.`);

  // ------ Panels and Circuits (for hierarchical load management) ------
  const panelRows: Array<{
    siteId: string;
    name: string;
    breakerRatingAmps: number;
    voltageV: number;
    phases: number;
    maxContinuousKw: string;
    safetyMarginKw: string;
  }> = [];
  for (let i = 0; i < Math.min(8, createdSites.length); i++) {
    const site = createdSites[i];
    if (site == null) continue;
    const amps = [100, 200, 150, 200, 100, 150, 200, 100][i] ?? 200;
    const voltage = 240;
    const phases = i % 3 === 0 ? 3 : 1;
    const maxKw = (amps * voltage * phases * 0.8) / 1000;
    panelRows.push({
      siteId: site.id,
      name: `Main Panel ${String.fromCharCode(65 + i)}`,
      breakerRatingAmps: amps,
      voltageV: voltage,
      phases,
      maxContinuousKw: String(maxKw),
      safetyMarginKw: String(randomInt(2, 8)),
    });
  }
  const createdPanels = await db.insert(panels).values(panelRows).returning();
  console.log(`  ${String(createdPanels.length)} panels created.`);

  // Create 2 circuits per panel and assign stations
  const circuitRows: Array<{
    panelId: string;
    name: string;
    breakerRatingAmps: number;
    maxContinuousKw: string;
  }> = [];
  for (const panel of createdPanels) {
    const parentVoltage = panelRows.find((p) => p.siteId === panel.siteId)?.voltageV ?? 240;
    const parentPhases = panelRows.find((p) => p.siteId === panel.siteId)?.phases ?? 1;
    for (let c = 0; c < 2; c++) {
      const circuitAmps = [40, 50][c] ?? 40;
      const circuitMaxKw = (circuitAmps * parentVoltage * parentPhases * 0.8) / 1000;
      circuitRows.push({
        panelId: panel.id,
        name: `Circuit ${String(c + 1)}`,
        breakerRatingAmps: circuitAmps,
        maxContinuousKw: String(circuitMaxKw),
      });
    }
  }
  const createdCircuits = await db.insert(circuits).values(circuitRows).returning();
  console.log(`  ${String(createdCircuits.length)} circuits created.`);

  // Assign stations to circuits (round-robin among circuits for the same site)
  const circuitsBySite = new Map<string, string[]>();
  for (const circuit of createdCircuits) {
    const panelRow = createdPanels.find((p) => p.id === circuit.panelId);
    if (panelRow == null) continue;
    const list = circuitsBySite.get(panelRow.siteId) ?? [];
    list.push(circuit.id);
    circuitsBySite.set(panelRow.siteId, list);
  }
  let assignedCount = 0;
  // stationRows has siteId, createdStations has id. Zip them together.
  for (let si = 0; si < stationRows.length; si++) {
    const stationInput = stationRows[si];
    const stationCreated = createdStations[si];
    if (stationInput == null || stationCreated == null) continue;
    const siteCircuits = circuitsBySite.get(stationInput.siteId);
    if (siteCircuits == null || siteCircuits.length === 0) continue;
    const circuitId = siteCircuits[assignedCount % siteCircuits.length];
    if (circuitId == null) continue;
    await db
      .update(chargingStations)
      .set({ circuitId })
      .where(eq(chargingStations.id, stationCreated.id));
    assignedCount++;
  }
  console.log(`  ${String(assignedCount)} stations assigned to circuits.`);

  // ------ EVSEs (400 - 2 per station) and Connectors (400) ------
  // All connectors start unavailable. The CSS simulator sets them available via StatusNotification after connecting.
  const connectorStatuses: Array<
    'available' | 'occupied' | 'reserved' | 'unavailable' | 'faulted'
  > = ['unavailable'];
  const evseRows: Array<{
    stationId: string;
    evseId: number;
    status: 'available' | 'occupied' | 'reserved' | 'unavailable' | 'faulted';
  }> = [];
  const evseStationIdx: number[] = [];
  let autoCreateGapCount = 0;
  for (let i = 0; i < createdStations.length; i++) {
    const is16 = i >= 160;
    // 1.6 stations get 1-2 connectors, each with its own EVSE (1:1 mapping)
    // 2.1 stations get 2-3 EVSEs
    // IOCHARGER-001 (i=0): single EVSE
    const numEvses = i === 0 ? 1 : is16 ? randomInt(1, 2) : i % 5 === 0 ? 3 : 2;
    // For every 10th 2.1 station (except IOCHARGER-001), skip the last EVSE so the simulator triggers auto-creation
    const maxEvse = !is16 && i % 10 === 0 && i !== 0 ? numEvses - 1 : numEvses;
    if (!is16 && i % 10 === 0) autoCreateGapCount++;
    for (let e = 1; e <= maxEvse; e++) {
      evseRows.push({
        stationId: at(createdStations, i).id,
        evseId: e,
        status: pick(connectorStatuses),
      });
      evseStationIdx.push(i);
    }
  }
  console.log(
    `  ${String(autoCreateGapCount)} stations have missing EVSEs for auto-creation testing.`,
  );
  const createdEvses = await db
    .insert(evses)
    .values(evseRows)
    .returning({ id: evses.id, stationId: evses.stationId });
  console.log(`  ${String(createdEvses.length)} EVSEs created.`);

  // Create connectors - some EVSEs get multiple connectors
  // DC fast chargers (CCS2 >= 50kW): ~50% get a second CHAdeMO connector
  // CHAdeMO stations: ~50% get a second CCS2 connector
  // AC Type2 stations: ~33% get a second Type1 connector
  const connectorRows: Array<{
    evseId: string;
    connectorId: number;
    status: 'available' | 'occupied' | 'reserved' | 'unavailable' | 'faulted';
    connectorType: string;
    maxPowerKw: string;
    maxCurrentAmps: number;
  }> = [];
  for (let i = 0; i < createdEvses.length; i++) {
    const stationIdx = at(evseStationIdx, i);
    const is16 = stationIdx >= 160;
    const modelInfo = at(stationModels, stationIdx);
    const evse = at(createdEvses, i);

    // IOCHARGER-001 (stationIdx=0): Level 2 AC charger with Type1 connector
    if (stationIdx === 0) {
      connectorRows.push({
        evseId: evse.id,
        connectorId: 1,
        status: 'unavailable' as const,
        connectorType: 'Type1',
        maxPowerKw: '7.68',
        maxCurrentAmps: 32,
      });
      continue;
    }

    // Primary connector
    connectorRows.push({
      evseId: evse.id,
      connectorId: 1,
      status: pick(connectorStatuses),
      connectorType: modelInfo.type,
      maxPowerKw: String(modelInfo.power),
      maxCurrentAmps: modelInfo.amps,
    });

    // 1.6 stations: 1 connector per EVSE (1:1 mapping), no secondary connectors
    if (is16) continue;

    // Secondary connector for multi-connector EVSEs (2.1 only)
    if (modelInfo.type === 'CCS2' && modelInfo.power >= 50 && i % 2 === 0) {
      connectorRows.push({
        evseId: evse.id,
        connectorId: 2,
        status: pick(connectorStatuses),
        connectorType: 'CHAdeMO',
        maxPowerKw: String(Math.min(modelInfo.power, 50)),
        maxCurrentAmps: Math.min(modelInfo.amps, 125),
      });
    } else if (modelInfo.type === 'CHAdeMO' && i % 2 === 0) {
      connectorRows.push({
        evseId: evse.id,
        connectorId: 2,
        status: pick(connectorStatuses),
        connectorType: 'CCS2',
        maxPowerKw: String(modelInfo.power),
        maxCurrentAmps: modelInfo.amps,
      });
    } else if (modelInfo.type === 'Type2' && i % 3 === 0) {
      connectorRows.push({
        evseId: evse.id,
        connectorId: 2,
        status: pick(connectorStatuses),
        connectorType: 'Type1',
        maxPowerKw: '7',
        maxCurrentAmps: 32,
      });
    }
  }
  await db.insert(connectors).values(connectorRows);
  console.log(`  ${String(connectorRows.length)} connectors created.`);

  // ------ Roles ------
  const [adminRole] = await db
    .insert(roles)
    .values({
      name: 'admin',
      description: 'Full system access',
      permissions: JSON.stringify(['*']),
    })
    .returning({ id: roles.id });

  const [operatorRole] = await db
    .insert(roles)
    .values({
      name: 'operator',
      description: 'Day-to-day operations access',
      permissions: JSON.stringify([
        'stations:*',
        'sessions:*',
        'drivers:*',
        'sites:*',
        'pricing:*',
        'fleets:*',
        'tokens:*',
        'dashboard:*',
        'reservations:*',
        'notifications:*',
        'support:*',
        'ocpi:*',
        'pnc:*',
        'payments:*',
        'load-management:*',
        'logs:*',
      ]),
    })
    .returning({ id: roles.id });

  const [viewerRole] = await db
    .insert(roles)
    .values({
      name: 'viewer',
      description: 'Read-only access',
    })
    .returning({ id: roles.id });

  if (adminRole == null || operatorRole == null || viewerRole == null) {
    throw new Error('Failed to create roles');
  }
  console.log('  3 roles created.');

  // ------ Users (20) ------
  const passwordHash = await argon2.hash('admin123');
  const userRows = [
    {
      email: 'admin@evtivity.local',
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      roleId: adminRole.id,
      hasAllSiteAccess: true,
    },
    // Operators 1-3: all-site access
    ...Array.from({ length: 3 }, (_, i) => ({
      email: `operator${String(i + 1)}@evtivity.local`,
      passwordHash,
      firstName: at(FIRST_NAMES, i),
      lastName: at(LAST_NAMES, i),
      roleId: operatorRole.id,
      hasAllSiteAccess: true,
    })),
    // Operators 4-9: specific site assignments (added below)
    ...Array.from({ length: 6 }, (_, i) => ({
      email: `operator${String(i + 4)}@evtivity.local`,
      passwordHash,
      firstName: at(FIRST_NAMES, i + 3),
      lastName: at(LAST_NAMES, i + 3),
      roleId: operatorRole.id,
    })),
  ];
  await db
    .insert(users)
    .values(userRows)
    .onConflictDoUpdate({
      target: users.email,
      set: { passwordHash: sql`EXCLUDED.password_hash`, updatedAt: new Date() },
    });
  console.log('  10 users created.');

  // ------ User Permissions ------
  const createdUsers = await db.select({ id: users.id, roleId: users.roleId }).from(users);

  const permRows: { userId: string; permission: string }[] = [];
  for (const u of createdUsers) {
    const defaults =
      u.roleId === adminRole.id ? ADMIN_DEFAULT_PERMISSIONS : OPERATOR_DEFAULT_PERMISSIONS;
    for (const perm of defaults) {
      permRows.push({ userId: u.id, permission: perm });
    }
  }
  if (permRows.length > 0) {
    await db.insert(userPermissions).values(permRows).onConflictDoNothing();
  }
  console.log(`  ${String(permRows.length)} user permission rows created.`);

  // ------ User Site Assignments ------
  // Operators 4-9 (indices 3-8 in the operator list) get specific site assignments
  // Distribute 20 sites across 6 operators so each has 3-5 sites with some overlap
  const operatorUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      sql`${users.email} IN ('operator4@evtivity.local','operator5@evtivity.local','operator6@evtivity.local','operator7@evtivity.local','operator8@evtivity.local','operator9@evtivity.local')`,
    );

  // Site distribution: each operator gets a slice of sites with some overlap
  const siteSlices: number[][] = [
    [0, 1, 2, 3, 4], // operator4: 5 sites (Main Campus through University Garage)
    [3, 4, 5, 6], // operator5: 4 sites (Central Mall through Hospital Complex)
    [6, 7, 8, 9, 10], // operator6: 5 sites (Hospital Complex through Sports Arena)
    [10, 11, 12], // operator7: 3 sites (Sports Arena through Office Tower)
    [12, 13, 14, 15, 16], // operator8: 5 sites (Office Tower through Community Center)
    [16, 17, 18, 19], // operator9: 4 sites (Community Center through Mountain Lodge)
  ];

  const siteAssignmentRows: { userId: string; siteId: string }[] = [];
  for (const opUser of operatorUsers) {
    const opIndex = Number(opUser.email.replace('operator', '').replace('@evtivity.local', '')) - 4;
    const siteIndices = siteSlices[opIndex];
    if (siteIndices == null) continue;
    for (const si of siteIndices) {
      const site = createdSites[si];
      if (site == null) continue;
      siteAssignmentRows.push({ userId: opUser.id, siteId: site.id });
    }
  }

  if (siteAssignmentRows.length > 0) {
    await db.insert(userSiteAssignments).values(siteAssignmentRows).onConflictDoNothing();
  }
  console.log(`  ${String(siteAssignmentRows.length)} user site assignments created.`);

  // ------ Drivers (150) ------
  const driverRows = Array.from({ length: 150 }, (_, i) => ({
    firstName: at(FIRST_NAMES, i),
    lastName: at(LAST_NAMES, i),
    email: `driver${String(i + 1)}@example.com`,
    phone: `+1${String(randomInt(200, 999))}${String(randomInt(1000000, 9999999))}`,
    isActive: Math.random() > 0.05,
    emailVerified: true,
  }));
  const createdDrivers = await db.insert(drivers).values(driverRows).returning({ id: drivers.id });
  console.log(`  ${String(createdDrivers.length)} drivers created.`);

  // ------ Portal Test Driver (1) ------
  const driverPasswordHash = await argon2.hash('driver123');
  const [portalTestDriver] = await db
    .insert(drivers)
    .values({
      firstName: 'Test',
      lastName: 'Driver',
      email: 'driver@evtivity.local',
      phone: '+15551234567',
      passwordHash: driverPasswordHash,
      registrationSource: 'portal',
      isActive: true,
      emailVerified: true,
    })
    .returning({ id: drivers.id });
  if (portalTestDriver == null) throw new Error('Failed to create portal test driver');
  console.log('  Portal test driver created.');

  // ------ Driver Tokens (200) ------
  const tokenTypes = ['ISO14443', 'ISO15693'];
  const tokenRows = createdDrivers.slice(0, 150).flatMap((driver, i) => {
    const tokens = [
      {
        driverId: driver.id,
        idToken: `RFID-${padNum(i + 1, 6)}`,
        tokenType: 'ISO14443',
        isActive: true,
      },
    ];
    if (i < 50) {
      const tt = pick(tokenTypes);
      tokens.push({
        driverId: driver.id,
        idToken: `${tt}-${padNum(i + 1000, 6)}`,
        tokenType: tt,
        isActive: Math.random() > 0.1,
      });
    }
    return tokens;
  });
  await db.insert(driverTokens).values(tokenRows);
  console.log(`  ${String(tokenRows.length)} driver tokens created.`);

  // ------ Driver Payment Methods (all drivers) ------
  const cardBrands = ['visa', 'mastercard', 'amex'];
  const paymentMethodRows = createdDrivers.map((driver, i) => ({
    driverId: driver.id,
    stripeCustomerId: `cus_sim_${padNum(i + 1, 6)}`,
    stripePaymentMethodId: `pm_sim_${padNum(i + 1, 6)}`,
    cardBrand: cardBrands[i % cardBrands.length] ?? 'visa',
    cardLast4: '4242',
    isDefault: true,
  }));
  await db.insert(driverPaymentMethods).values(paymentMethodRows);
  console.log(`  ${String(paymentMethodRows.length)} driver payment methods created.`);

  // ------ Vehicles (120) ------
  const vehicleRows = createdDrivers.slice(0, 120).map((driver, i) => {
    const evMake = pick(EV_MAKES);
    return {
      driverId: driver.id,
      make: evMake.make,
      model: pick(evMake.models),
      year: String(randomInt(2020, 2025)),
      vin: `${String(i + 1).padStart(4, '0')}ABCDEF${String(randomInt(10000, 99999))}`.slice(0, 17),
      licensePlate: `${String.fromCharCode(65 + randomInt(0, 25))}${String.fromCharCode(65 + randomInt(0, 25))}${String.fromCharCode(65 + randomInt(0, 25))}-${padNum(randomInt(1000, 9999), 4)}`,
    };
  });
  await db.insert(vehicles).values(vehicleRows);
  console.log(`  ${String(vehicleRows.length)} vehicles created.`);

  // ------ Fleets (15) ------
  const fleetRows = FLEET_NAMES.map((name) => ({
    name,
    description: `${name} - managed EV fleet`,
  }));
  const createdFleets = await db.insert(fleets).values(fleetRows).returning({ id: fleets.id });
  console.log(`  ${String(createdFleets.length)} fleets created.`);

  // ------ Fleet-Driver assignments (5-15 per fleet) ------
  const fleetDriverRows: Array<{ fleetId: string; driverId: string }> = [];
  const assignedPairs = new Set<string>();
  for (const fleet of createdFleets) {
    const count = randomInt(5, 15);
    for (let j = 0; j < count; j++) {
      const driver = pick(createdDrivers);
      const key = `${fleet.id}-${driver.id}`;
      if (!assignedPairs.has(key)) {
        assignedPairs.add(key);
        fleetDriverRows.push({ fleetId: fleet.id, driverId: driver.id });
      }
    }
  }
  if (fleetDriverRows.length > 0) {
    await db.insert(fleetDrivers).values(fleetDriverRows);
  }
  console.log(`  ${String(fleetDriverRows.length)} fleet-driver assignments created.`);

  // ------ Fleet-Station assignments (3-6 per fleet) ------
  const fleetStationRows: Array<{ fleetId: string; stationId: string }> = [];
  const fleetStationPairs = new Set<string>();
  for (const fleet of createdFleets) {
    const count = randomInt(3, 6);
    for (let j = 0; j < count; j++) {
      const station = pick(createdStations);
      const key = `${fleet.id}-${station.id}`;
      if (!fleetStationPairs.has(key)) {
        fleetStationPairs.add(key);
        fleetStationRows.push({ fleetId: fleet.id, stationId: station.id });
      }
    }
  }
  if (fleetStationRows.length > 0) {
    await db.insert(fleetStations).values(fleetStationRows);
  }
  console.log(`  ${String(fleetStationRows.length)} fleet-station assignments created.`);

  // ------ Pricing Holidays ------
  const holidayRows = [
    { name: "New Year's Day", date: '2026-01-01' },
    { name: 'Martin Luther King Jr. Day', date: '2026-01-19' },
    { name: "Presidents' Day", date: '2026-02-16' },
    { name: 'Memorial Day', date: '2026-05-25' },
    { name: 'Independence Day', date: '2026-07-04' },
    { name: 'Labor Day', date: '2026-09-07' },
    { name: 'Thanksgiving', date: '2026-11-26' },
    { name: 'Christmas Day', date: '2026-12-25' },
  ];
  await db.insert(pricingHolidays).values(holidayRows);
  console.log(`  ${String(holidayRows.length)} pricing holidays created.`);

  // ------ Pricing Groups and Tariffs (all restriction types) ------
  const pricingGroupDefs = [
    {
      name: 'Time-of-Day Standard',
      description: 'Full schedule with peak/off-peak/shoulder/holiday/energy tiers',
      isDefault: true,
    },
    {
      name: 'Premium DC Fast',
      description: 'High-power DC with weekday/weekend time splits',
      isDefault: false,
    },
    {
      name: 'Fleet Discount',
      description: 'Discounted fleet rate with seasonal and energy tiers',
      isDefault: false,
    },
    {
      name: 'Employee Benefit',
      description: 'Free off-peak charging with nominal peak rate',
      isDefault: false,
    },
    {
      name: 'Seasonal Resort',
      description: 'Summer/winter seasonal pricing for resort locations',
      isDefault: false,
    },
    {
      name: 'VIP',
      description: 'Free charging for VIP drivers',
      isDefault: false,
    },
  ];
  const createdPricingGroups = await db
    .insert(pricingGroups)
    .values(pricingGroupDefs)
    .returning({ id: pricingGroups.id });
  console.log(`  ${String(createdPricingGroups.length)} pricing groups created.`);

  // Group 0: Time-of-Day Standard (all restriction types)
  // Group 1: Premium DC Fast (day+time combos)
  // Group 2: Fleet Discount (seasonal + energy threshold)
  // Group 3: Employee Benefit (time-only)
  // Group 4: Seasonal Resort (date-range + holiday)
  const tariffRows = [
    // --- Group 0: Time-of-Day Standard ---
    // Default fallback (priority 0)
    {
      pricingGroupId: at(createdPricingGroups, 0).id,
      name: 'Standard Rate',
      currency: 'USD',
      pricePerKwh: '0.30',
      pricePerMinute: '0.02',
      pricePerSession: '1.00',
      idleFeePricePerMinute: '0.15',
      taxRate: '0.0825',
      isActive: true,
      priority: 0,
      isDefault: true,
      restrictions: null,
    },
    // Time-only: peak hours (priority 10)
    {
      pricingGroupId: at(createdPricingGroups, 0).id,
      name: 'Peak Hours',
      currency: 'USD',
      pricePerKwh: '0.48',
      pricePerMinute: '0.05',
      pricePerSession: '1.50',
      idleFeePricePerMinute: '0.25',
      taxRate: '0.0825',
      isActive: true,
      priority: 10,
      isDefault: false,
      restrictions: { timeRange: { startTime: '16:00', endTime: '21:00' } },
    },
    // Time-only: off-peak overnight with midnight crossing (priority 10)
    {
      pricingGroupId: at(createdPricingGroups, 0).id,
      name: 'Off-Peak Overnight',
      currency: 'USD',
      pricePerKwh: '0.18',
      pricePerMinute: '0.00',
      pricePerSession: '0.50',
      idleFeePricePerMinute: '0.00',
      taxRate: '0.0825',
      isActive: true,
      priority: 10,
      isDefault: false,
      restrictions: { timeRange: { startTime: '23:00', endTime: '06:00' } },
    },
    // Day+time: weekday peak (priority 20)
    {
      pricingGroupId: at(createdPricingGroups, 0).id,
      name: 'Weekday Business Hours',
      currency: 'USD',
      pricePerKwh: '0.42',
      pricePerMinute: '0.04',
      pricePerSession: '1.25',
      idleFeePricePerMinute: '0.20',
      taxRate: '0.0825',
      isActive: true,
      priority: 20,
      isDefault: false,
      restrictions: {
        daysOfWeek: [1, 2, 3, 4, 5],
        timeRange: { startTime: '08:00', endTime: '17:00' },
      },
    },
    // Day+time: weekend daytime (priority 20)
    {
      pricingGroupId: at(createdPricingGroups, 0).id,
      name: 'Weekend Daytime',
      currency: 'USD',
      pricePerKwh: '0.25',
      pricePerMinute: '0.01',
      pricePerSession: '0.75',
      idleFeePricePerMinute: '0.10',
      taxRate: '0.0825',
      isActive: true,
      priority: 20,
      isDefault: false,
      restrictions: {
        daysOfWeek: [0, 6],
        timeRange: { startTime: '09:00', endTime: '21:00' },
      },
    },
    // Holiday (priority 40)
    {
      pricingGroupId: at(createdPricingGroups, 0).id,
      name: 'Holiday Rate',
      currency: 'USD',
      pricePerKwh: '0.22',
      pricePerMinute: '0.01',
      pricePerSession: '0.50',
      idleFeePricePerMinute: '0.00',
      taxRate: '0.0825',
      isActive: true,
      priority: 40,
      isDefault: false,
      restrictions: { holidays: true },
    },
    // Energy threshold: high-usage surcharge (priority 50)
    {
      pricingGroupId: at(createdPricingGroups, 0).id,
      name: 'High Usage Surcharge',
      currency: 'USD',
      pricePerKwh: '0.55',
      pricePerMinute: '0.06',
      pricePerSession: '2.00',
      idleFeePricePerMinute: '0.30',
      taxRate: '0.0825',
      isActive: true,
      priority: 50,
      isDefault: false,
      restrictions: { energyThresholdKwh: 80 },
    },

    // --- Group 1: Premium DC Fast ---
    // Default
    {
      pricingGroupId: at(createdPricingGroups, 1).id,
      name: 'DC Base Rate',
      currency: 'USD',
      pricePerKwh: '0.50',
      pricePerMinute: '0.08',
      pricePerSession: '2.00',
      idleFeePricePerMinute: '0.40',
      taxRate: '0.0725',
      isActive: true,
      priority: 0,
      isDefault: true,
      restrictions: null,
    },
    // Day+time: weekday morning rush (priority 20)
    {
      pricingGroupId: at(createdPricingGroups, 1).id,
      name: 'Weekday Morning Rush',
      currency: 'USD',
      pricePerKwh: '0.65',
      pricePerMinute: '0.10',
      pricePerSession: '2.50',
      idleFeePricePerMinute: '0.50',
      taxRate: '0.0725',
      isActive: true,
      priority: 20,
      isDefault: false,
      restrictions: {
        daysOfWeek: [1, 2, 3, 4, 5],
        timeRange: { startTime: '07:00', endTime: '10:00' },
      },
    },
    // Day+time: weekday evening rush (priority 20)
    {
      pricingGroupId: at(createdPricingGroups, 1).id,
      name: 'Weekday Evening Rush',
      currency: 'USD',
      pricePerKwh: '0.68',
      pricePerMinute: '0.10',
      pricePerSession: '2.50',
      idleFeePricePerMinute: '0.50',
      taxRate: '0.0725',
      isActive: true,
      priority: 20,
      isDefault: false,
      restrictions: {
        daysOfWeek: [1, 2, 3, 4, 5],
        timeRange: { startTime: '17:00', endTime: '20:00' },
      },
    },
    // Day+time: weekend all day (priority 20)
    {
      pricingGroupId: at(createdPricingGroups, 1).id,
      name: 'Weekend Rate',
      currency: 'USD',
      pricePerKwh: '0.45',
      pricePerMinute: '0.06',
      pricePerSession: '1.50',
      idleFeePricePerMinute: '0.30',
      taxRate: '0.0725',
      isActive: true,
      priority: 20,
      isDefault: false,
      restrictions: {
        daysOfWeek: [0, 6],
        timeRange: { startTime: '06:00', endTime: '22:00' },
      },
    },
    // Holiday (priority 40)
    {
      pricingGroupId: at(createdPricingGroups, 1).id,
      name: 'Holiday Discount',
      currency: 'USD',
      pricePerKwh: '0.40',
      pricePerMinute: '0.04',
      pricePerSession: '1.00',
      idleFeePricePerMinute: '0.20',
      taxRate: '0.0725',
      isActive: true,
      priority: 40,
      isDefault: false,
      restrictions: { holidays: true },
    },
    // Energy threshold: ultra-high usage (priority 50)
    {
      pricingGroupId: at(createdPricingGroups, 1).id,
      name: 'Ultra-High Usage',
      currency: 'USD',
      pricePerKwh: '0.75',
      pricePerMinute: '0.12',
      pricePerSession: '3.00',
      idleFeePricePerMinute: '0.60',
      taxRate: '0.0725',
      isActive: true,
      priority: 50,
      isDefault: false,
      restrictions: { energyThresholdKwh: 100 },
    },

    // --- Group 2: Fleet Discount ---
    // Default
    {
      pricingGroupId: at(createdPricingGroups, 2).id,
      name: 'Fleet Base Rate',
      currency: 'USD',
      pricePerKwh: '0.20',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      taxRate: '0.0825',
      isActive: true,
      priority: 0,
      isDefault: true,
      restrictions: null,
    },
    // Time-only: fleet overnight charging discount (priority 10)
    {
      pricingGroupId: at(createdPricingGroups, 2).id,
      name: 'Fleet Overnight',
      currency: 'USD',
      pricePerKwh: '0.12',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      taxRate: '0.0825',
      isActive: true,
      priority: 10,
      isDefault: false,
      restrictions: { timeRange: { startTime: '22:00', endTime: '05:00' } },
    },
    // Seasonal: summer peak demand (priority 30)
    {
      pricingGroupId: at(createdPricingGroups, 2).id,
      name: 'Summer Peak Surcharge',
      currency: 'USD',
      pricePerKwh: '0.28',
      pricePerMinute: '0.02',
      pricePerSession: '0.50',
      taxRate: '0.0825',
      isActive: true,
      priority: 30,
      isDefault: false,
      restrictions: { dateRange: { startDate: '06-01', endDate: '09-30' } },
    },
    // Seasonal: winter off-peak (priority 30)
    {
      pricingGroupId: at(createdPricingGroups, 2).id,
      name: 'Winter Discount',
      currency: 'USD',
      pricePerKwh: '0.14',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      taxRate: '0.0825',
      isActive: true,
      priority: 30,
      isDefault: false,
      restrictions: { dateRange: { startDate: '11-01', endDate: '02-28' } },
    },
    // Energy threshold: bulk charging (priority 50)
    {
      pricingGroupId: at(createdPricingGroups, 2).id,
      name: 'Fleet Bulk Discount',
      currency: 'USD',
      pricePerKwh: '0.10',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      taxRate: '0.0825',
      isActive: true,
      priority: 50,
      isDefault: false,
      restrictions: { energyThresholdKwh: 50 },
    },

    // --- Group 3: Employee Benefit ---
    // Default (free off-peak)
    {
      pricingGroupId: at(createdPricingGroups, 3).id,
      name: 'Employee Free Charging',
      currency: 'USD',
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '0.10',
      taxRate: '0.00',
      isActive: true,
      priority: 0,
      isDefault: true,
      restrictions: null,
    },
    // Time-only: nominal peak rate (priority 10)
    {
      pricingGroupId: at(createdPricingGroups, 3).id,
      name: 'Employee Peak Rate',
      currency: 'USD',
      pricePerKwh: '0.10',
      pricePerMinute: '0.01',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '0.15',
      taxRate: '0.00',
      isActive: true,
      priority: 10,
      isDefault: false,
      restrictions: { timeRange: { startTime: '12:00', endTime: '14:00' } },
    },
    // Day+time: Friday afternoon free (priority 20)
    {
      pricingGroupId: at(createdPricingGroups, 3).id,
      name: 'Friday Afternoon Free',
      currency: 'USD',
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '0.00',
      taxRate: '0.00',
      isActive: true,
      priority: 20,
      isDefault: false,
      restrictions: {
        daysOfWeek: [5],
        timeRange: { startTime: '13:00', endTime: '18:00' },
      },
    },
    // Holiday: employee holiday bonus (priority 40)
    {
      pricingGroupId: at(createdPricingGroups, 3).id,
      name: 'Holiday Free Charging',
      currency: 'USD',
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '0.00',
      taxRate: '0.00',
      isActive: true,
      priority: 40,
      isDefault: false,
      restrictions: { holidays: true },
    },

    // --- Group 4: Seasonal Resort ---
    // Default
    {
      pricingGroupId: at(createdPricingGroups, 4).id,
      name: 'Resort Base Rate',
      currency: 'USD',
      pricePerKwh: '0.35',
      pricePerMinute: '0.03',
      pricePerSession: '1.50',
      idleFeePricePerMinute: '0.20',
      taxRate: '0.09',
      isActive: true,
      priority: 0,
      isDefault: true,
      restrictions: null,
    },
    // Time-only: resort evening discount (priority 10)
    {
      pricingGroupId: at(createdPricingGroups, 4).id,
      name: 'Evening Discount',
      currency: 'USD',
      pricePerKwh: '0.25',
      pricePerMinute: '0.01',
      pricePerSession: '0.75',
      idleFeePricePerMinute: '0.10',
      taxRate: '0.09',
      isActive: true,
      priority: 10,
      isDefault: false,
      restrictions: { timeRange: { startTime: '20:00', endTime: '08:00' } },
    },
    // Seasonal: summer peak (priority 30)
    {
      pricingGroupId: at(createdPricingGroups, 4).id,
      name: 'Summer Peak Season',
      currency: 'USD',
      pricePerKwh: '0.55',
      pricePerMinute: '0.06',
      pricePerSession: '2.50',
      idleFeePricePerMinute: '0.35',
      taxRate: '0.09',
      isActive: true,
      priority: 30,
      isDefault: false,
      restrictions: { dateRange: { startDate: '05-15', endDate: '09-15' } },
    },
    // Seasonal: ski season (priority 30, year-wrapping date range)
    {
      pricingGroupId: at(createdPricingGroups, 4).id,
      name: 'Ski Season Premium',
      currency: 'USD',
      pricePerKwh: '0.50',
      pricePerMinute: '0.05',
      pricePerSession: '2.00',
      idleFeePricePerMinute: '0.30',
      taxRate: '0.09',
      isActive: true,
      priority: 30,
      isDefault: false,
      restrictions: { dateRange: { startDate: '11-15', endDate: '03-31' } },
    },
    // Holiday: resort holiday premium (priority 40)
    {
      pricingGroupId: at(createdPricingGroups, 4).id,
      name: 'Holiday Premium',
      currency: 'USD',
      pricePerKwh: '0.60',
      pricePerMinute: '0.08',
      pricePerSession: '3.00',
      idleFeePricePerMinute: '0.50',
      taxRate: '0.09',
      isActive: true,
      priority: 40,
      isDefault: false,
      restrictions: { holidays: true },
    },
    // Energy threshold (priority 50)
    {
      pricingGroupId: at(createdPricingGroups, 4).id,
      name: 'Heavy Usage Rate',
      currency: 'USD',
      pricePerKwh: '0.70',
      pricePerMinute: '0.10',
      pricePerSession: '3.50',
      idleFeePricePerMinute: '0.50',
      taxRate: '0.09',
      isActive: true,
      priority: 50,
      isDefault: false,
      restrictions: { energyThresholdKwh: 60 },
    },

    // --- Group 5: VIP ---
    {
      pricingGroupId: at(createdPricingGroups, 5).id,
      name: 'VIP Free Charging',
      currency: 'USD',
      pricePerKwh: '0.00',
      pricePerMinute: '0.00',
      pricePerSession: '0.00',
      idleFeePricePerMinute: '0.00',
      taxRate: '0.00',
      isActive: true,
      priority: 0,
      isDefault: true,
    },
  ];
  await db.insert(tariffs).values(tariffRows);
  console.log(`  ${String(tariffRows.length)} tariffs created.`);

  // ------ Pricing Group Station assignments (100) ------
  const pgStationRows: Array<{ pricingGroupId: string; stationId: string }> = [];
  const pgStationPairs = new Set<string>();
  for (let i = 0; i < createdStations.length; i++) {
    const pg = at(createdPricingGroups, i);
    const station = at(createdStations, i);
    const key = `${pg.id}-${station.id}`;
    if (!pgStationPairs.has(key)) {
      pgStationPairs.add(key);
      pgStationRows.push({ pricingGroupId: pg.id, stationId: station.id });
    }
  }
  await db.insert(pricingGroupStations).values(pgStationRows);
  console.log(`  ${String(pgStationRows.length)} pricing-group-station assignments created.`);

  // ------ Pricing Group Fleet assignments (one per fleet, roughly half the fleets) ------
  const pgFleetRows: Array<{ pricingGroupId: string; fleetId: string }> = [];
  const pgFleetIds = new Set<string>();
  for (let i = 0; i < createdFleets.length; i++) {
    if (i % 2 !== 0) continue;
    const pg = pick(createdPricingGroups);
    const fleet = at(createdFleets, i);
    if (!pgFleetIds.has(fleet.id)) {
      pgFleetIds.add(fleet.id);
      pgFleetRows.push({ pricingGroupId: pg.id, fleetId: fleet.id });
    }
  }
  if (pgFleetRows.length > 0) {
    await db.insert(pricingGroupFleets).values(pgFleetRows);
  }
  console.log(`  ${String(pgFleetRows.length)} pricing-group-fleet assignments created.`);

  // ------ Pricing Group Site assignments (one per site, roughly half the sites) ------
  const pgSiteRows: Array<{ pricingGroupId: string; siteId: string }> = [];
  const pgSiteIds = new Set<string>();
  for (let i = 0; i < createdSites.length; i++) {
    if (i % 2 !== 0) continue;
    const pg = pick(createdPricingGroups);
    const site = at(createdSites, i);
    if (!pgSiteIds.has(site.id)) {
      pgSiteIds.add(site.id);
      pgSiteRows.push({ pricingGroupId: pg.id, siteId: site.id });
    }
  }
  if (pgSiteRows.length > 0) {
    await db.insert(pricingGroupSites).values(pgSiteRows);
  }
  console.log(`  ${String(pgSiteRows.length)} pricing-group-site assignments created.`);

  // ------ VIP Pricing Group Driver assignment ------
  await db.insert(pricingGroupDrivers).values({
    pricingGroupId: at(createdPricingGroups, 5).id,
    driverId: portalTestDriver.id,
  });
  console.log('  VIP pricing group assigned to driver@evtivity.local.');

  // ------ Charging Sessions (10000) ------
  const sessionStatuses: Array<'active' | 'completed' | 'faulted'> = [
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
    'active',
    'faulted',
  ];
  const stopReasons = [
    'EVDisconnected',
    'Local',
    'Remote',
    'PowerLoss',
    'EmergencyStop',
    'DeAuthorized',
  ];

  const sessionRows: Array<{
    stationId: string;
    evseId: string;
    connectorId: string;
    driverId: string;
    transactionId: string;
    status: 'active' | 'completed' | 'faulted';
    startedAt: Date;
    endedAt: Date | null;
    meterStart: number;
    meterStop: number | null;
    energyDeliveredWh: string | null;
    stoppedReason: string | null;
    currentCostCents: number | null;
    finalCostCents: number | null;
  }> = [];

  for (let i = 0; i < 10000; i++) {
    let status = pick(sessionStatuses);
    const stationIdx = i % createdStations.length;
    // IOCHARGER-001 (index 0): never seed active sessions to avoid stale session conflicts
    if (stationIdx === 0 && status === 'active') status = 'completed';
    const stationEvses = createdEvses.filter(
      (e) => e.stationId === at(createdStations, stationIdx).id,
    );
    const evse = stationEvses.length > 0 ? pick(stationEvses) : at(createdEvses, i);
    const driver = pick(createdDrivers);
    const startedAt = randomDate(90);
    const durationMinutes = randomInt(5, 240);
    const endedAt =
      status !== 'active' ? new Date(startedAt.getTime() + durationMinutes * 60 * 1000) : null;
    const meterStart = randomInt(0, 500000);
    const energyWh = randomInt(500, 80000);
    const meterStop = status !== 'active' ? meterStart + energyWh : null;
    // Cost: ~$0.15-0.30/kWh, so cents = energyWh / 1000 * 15-30
    const costCents = Math.round((energyWh / 1000) * randomInt(15, 30));

    sessionRows.push({
      stationId: at(createdStations, stationIdx).id,
      evseId: evse.id,
      connectorId: at(connectorRows, createdEvses.indexOf(evse)).evseId,
      driverId: driver.id,
      transactionId: createId('session'),
      status,
      startedAt,
      endedAt,
      meterStart,
      meterStop,
      energyDeliveredWh: status !== 'active' ? String(energyWh) : null,
      stoppedReason: status === 'completed' ? pick(stopReasons) : null,
      currentCostCents: status === 'active' ? costCents : null,
      finalCostCents: status !== 'active' ? costCents : null,
    });
  }

  // Insert sessions without connectorId (it is optional anyway per schema)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const sessionInsertRows = sessionRows.map(({ connectorId, ...rest }) => rest);
  const createdSessions: Array<{
    id: string;
    stationId: string;
    status: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
  }> = [];
  for (let i = 0; i < sessionInsertRows.length; i += 500) {
    const batch = await db
      .insert(chargingSessions)
      .values(sessionInsertRows.slice(i, i + 500))
      .returning({
        id: chargingSessions.id,
        stationId: chargingSessions.stationId,
        status: chargingSessions.status,
        startedAt: chargingSessions.startedAt,
        endedAt: chargingSessions.endedAt,
      });
    createdSessions.push(...batch);
  }
  console.log(`  ${String(createdSessions.length)} charging sessions created.`);

  // ------ Payment Records for seeded sessions ------
  const driverIdToIndex = new Map<string, number>();
  for (let di = 0; di < createdDrivers.length; di++) {
    driverIdToIndex.set(at(createdDrivers, di).id, di);
  }

  const paymentRecordRows = createdSessions
    .map((session, i) => {
      const sessionRow = sessionRows[i];
      if (sessionRow == null) return null;
      const driverId = sessionRow.driverId;
      const intentId = `pi_sim_${padNum(i + 1, 10)}`;
      const driverIdx = driverIdToIndex.get(driverId) ?? 0;
      const customerId = `cus_sim_${padNum(driverIdx + 1, 6)}`;

      if (sessionRow.status === 'completed') {
        const capturedCents = sessionRow.finalCostCents ?? 0;
        const isPartialRefund = i % 5 === 4;
        const refundedCents = isPartialRefund
          ? randomInt(100, Math.max(101, Math.floor(capturedCents / 2)))
          : 0;
        return {
          sessionId: session.id,
          driverId,
          stripePaymentIntentId: intentId,
          stripeCustomerId: customerId,
          paymentSource: 'web_portal' as const,
          currency: 'USD',
          preAuthAmountCents: 5000,
          capturedAmountCents: capturedCents,
          refundedAmountCents: refundedCents,
          status: isPartialRefund ? ('partially_refunded' as const) : ('captured' as const),
        };
      } else if (sessionRow.status === 'active') {
        // Skip active sessions -- the simulator's Started handler creates their payment records
        return null;
      } else {
        return {
          sessionId: session.id,
          driverId,
          stripePaymentIntentId: intentId,
          stripeCustomerId: customerId,
          paymentSource: 'web_portal' as const,
          currency: 'USD',
          preAuthAmountCents: 5000,
          capturedAmountCents: 0,
          status: 'cancelled' as const,
        };
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  for (let i = 0; i < paymentRecordRows.length; i += 500) {
    await db.insert(paymentRecords).values(paymentRecordRows.slice(i, i + 500));
  }
  console.log(`  ${String(paymentRecordRows.length)} payment records created.`);

  // ------ Transaction Events (~3 per session) ------
  const triggerReasons = [
    'Authorized',
    'CablePluggedIn',
    'ChargingStateChanged',
    'EVCommunicationLost',
    'MeterValuePeriodic',
    'StopAuthorized',
  ];
  const eventRows: Array<{
    sessionId: string;
    eventType: 'started' | 'updated' | 'ended';
    seqNo: number;
    timestamp: Date;
    triggerReason: string;
  }> = [];

  for (const session of createdSessions) {
    const start = session.startedAt ?? new Date();

    eventRows.push({
      sessionId: session.id,
      eventType: 'started',
      seqNo: 0,
      timestamp: start,
      triggerReason: 'Authorized',
    });

    const updateCount = randomInt(1, 3);
    for (let u = 0; u < updateCount; u++) {
      eventRows.push({
        sessionId: session.id,
        eventType: 'updated',
        seqNo: u + 1,
        timestamp: new Date(start.getTime() + (u + 1) * randomInt(60000, 600000)),
        triggerReason: pick(triggerReasons),
      });
    }

    if (session.status !== 'active') {
      const end = session.endedAt ?? new Date();
      eventRows.push({
        sessionId: session.id,
        eventType: 'ended',
        seqNo: updateCount + 1,
        timestamp: end,
        triggerReason: 'StopAuthorized',
      });
    }
  }

  // Batch insert to avoid query size limits
  for (let i = 0; i < eventRows.length; i += 500) {
    await db.insert(transactionEvents).values(eventRows.slice(i, i + 500));
  }
  console.log(`  ${String(eventRows.length)} transaction events created.`);

  // ------ Meter Values ------
  const measurands = [
    'Energy.Active.Import.Register',
    'Power.Active.Import',
    'Current.Import',
    'Voltage',
    'SoC',
  ];
  const meterValueRows: Array<{
    stationId: string;
    sessionId: string;
    timestamp: Date;
    measurand: string;
    unit: string;
    value: string;
    context: string;
    location: string;
  }> = [];

  for (const session of createdSessions.slice(0, 8000)) {
    const start = session.startedAt ?? new Date();
    const meterCount = randomInt(3, 8);
    for (let m = 0; m < meterCount; m++) {
      const measurand = pick(measurands);
      let value: number;
      let unit: string;
      switch (measurand) {
        case 'Energy.Active.Import.Register':
          value = randomInt(100, 80000);
          unit = 'Wh';
          break;
        case 'Power.Active.Import':
          value = randomInt(1000, 150000);
          unit = 'W';
          break;
        case 'Current.Import':
          value = randomInt(1, 400);
          unit = 'A';
          break;
        case 'Voltage':
          value = randomInt(200, 480);
          unit = 'V';
          break;
        case 'SoC':
          value = randomInt(10, 100);
          unit = 'Percent';
          break;
        default:
          value = 0;
          unit = 'Wh';
      }
      meterValueRows.push({
        stationId: session.stationId,
        sessionId: session.id,
        timestamp: new Date(start.getTime() + m * randomInt(30000, 120000)),
        measurand,
        unit,
        value: String(value),
        context: 'Sample.Periodic',
        location: 'Outlet',
      });
    }
  }

  for (let i = 0; i < meterValueRows.length; i += 500) {
    await db.insert(meterValues).values(meterValueRows.slice(i, i + 500));
  }
  console.log(`  ${String(meterValueRows.length)} meter values created.`);

  // ------ Reservations (30) ------
  const reservationStatuses: Array<'active' | 'used' | 'cancelled' | 'expired'> = [
    'active',
    'used',
    'cancelled',
    'expired',
  ];
  const reservationRows = Array.from({ length: 30 }, (_, i) => {
    const stationIdx = i % createdStations.length;
    const stationEvses = createdEvses.filter(
      (e) => e.stationId === at(createdStations, stationIdx).id,
    );
    const evse = stationEvses.length > 0 ? pick(stationEvses) : at(createdEvses, i);
    const status = pick(reservationStatuses);
    return {
      reservationId: i + 1,
      stationId: at(createdStations, stationIdx).id,
      evseId: evse.id,
      driverId: pick(createdDrivers).id,
      status,
      expiresAt: new Date(
        Date.now() +
          (status === 'active' ? randomInt(1, 24) * 3600 * 1000 : -randomInt(1, 48) * 3600 * 1000),
      ),
    };
  });
  await db.insert(reservations).values(reservationRows);

  // Link "used" reservations to completed sessions at the same station
  const insertedReservations = await db
    .select({ id: reservations.id, stationId: reservations.stationId, status: reservations.status })
    .from(reservations);
  const usedReservations = insertedReservations.filter((r) => r.status === 'used');
  let linkedCount = 0;
  for (const res of usedReservations) {
    const matchingSession = createdSessions.find(
      (s) => s.stationId === res.stationId && s.status === 'completed',
    );
    if (matchingSession != null) {
      await db
        .update(chargingSessions)
        .set({ reservationId: res.id })
        .where(eq(chargingSessions.id, matchingSession.id));
      linkedCount++;
    }
  }
  console.log(
    `  ${String(reservationRows.length)} reservations created (${String(linkedCount)} linked to sessions).`,
  );

  // ------ Support Cases (10) with linked sessions and messages ------
  // Reset the sequence so case numbers start fresh
  await db.execute(sql`SELECT setval('support_case_number_seq', 1, false)`);

  const caseCategories: Array<
    | 'billing_dispute'
    | 'charging_failure'
    | 'connector_damage'
    | 'account_issue'
    | 'payment_problem'
    | 'reservation_issue'
    | 'general_inquiry'
  > = [
    'billing_dispute',
    'charging_failure',
    'payment_problem',
    'connector_damage',
    'account_issue',
    'billing_dispute',
    'general_inquiry',
    'charging_failure',
    'reservation_issue',
    'payment_problem',
  ];
  const casePriorities: Array<'low' | 'medium' | 'high' | 'urgent'> = [
    'high',
    'urgent',
    'medium',
    'low',
    'high',
    'medium',
    'urgent',
    'low',
    'medium',
    'high',
  ];
  const caseStatuses: Array<'open' | 'in_progress' | 'waiting_on_driver' | 'resolved'> = [
    'open',
    'in_progress',
    'waiting_on_driver',
    'open',
    'in_progress',
    'resolved',
    'open',
    'in_progress',
    'open',
    'waiting_on_driver',
  ];
  const caseSubjects = [
    'Overcharged for session on Jan 15',
    'Charger stopped mid-session',
    'Payment not processed correctly',
    'Connector cable damaged at station CS-0042',
    'Cannot log into my account',
    'Double charge on credit card',
    'Question about pricing tiers',
    'Error code displayed during charging',
    'Reservation disappeared',
    'Refund not received after failed session',
  ];
  const caseDescriptions = [
    'I was charged $45 but only used 12 kWh of energy. The rate should have been much lower.',
    'The charger stopped after 10 minutes and displayed an error. My car was only at 30%.',
    'My payment shows as pending for over a week. The session completed successfully.',
    'The CCS2 connector has visible damage to the pins. Please inspect and repair.',
    'I reset my password but still cannot log in. Getting "invalid credentials" error.',
    'I see two charges on my statement for the same session. Please refund the duplicate.',
    'Can you explain the difference between Standard AC and Premium DC pricing?',
    'The station showed error F-0042 and would not start. I tried multiple times.',
    'I made a reservation for 3 PM but when I arrived it said no reservation found.',
    'My session failed after 2 minutes but I was still charged the full pre-auth amount.',
  ];

  const caseRows = Array.from({ length: 10 }, (_, i) => {
    const caseDate = randomDate(30);
    return {
      caseNumber: `CASE-${padNum(1000 + i, 5)}`,
      subject: caseSubjects[i] as string,
      description: caseDescriptions[i] as string,
      status: caseStatuses[i] as 'open' | 'in_progress' | 'waiting_on_driver' | 'resolved',
      category: caseCategories[i] as
        | 'billing_dispute'
        | 'charging_failure'
        | 'connector_damage'
        | 'account_issue'
        | 'payment_problem'
        | 'reservation_issue'
        | 'general_inquiry',
      priority: casePriorities[i] as 'low' | 'medium' | 'high' | 'urgent',
      driverId: at(createdDrivers, i).id,
      createdByDriver: i % 2 === 0,
      createdAt: caseDate,
      updatedAt: caseDate,
      resolvedAt:
        caseStatuses[i] === 'resolved'
          ? new Date(caseDate.getTime() + randomInt(1, 5) * 24 * 60 * 60 * 1000)
          : null,
    };
  });

  const createdCases = await db
    .insert(supportCases)
    .values(caseRows)
    .returning({ id: supportCases.id });
  // Update the sequence to match
  await db.execute(sql`SELECT setval('support_case_number_seq', 11, false)`);
  console.log(`  ${String(createdCases.length)} support cases created.`);

  // Link each case to 1-3 sessions that have payment records (so refund UI shows)
  const sessionsWithPayments = paymentRecordRows.map((p, idx) => ({
    sessionId: p.sessionId,
    index: idx,
  }));
  const caseSessionRows: Array<{ caseId: string; sessionId: string }> = [];
  for (let i = 0; i < createdCases.length; i++) {
    const numSessions = randomInt(1, 3);
    const startIdx = (i * 3) % sessionsWithPayments.length;
    for (let j = 0; j < numSessions; j++) {
      const entry = at(sessionsWithPayments, startIdx + j);
      caseSessionRows.push({
        caseId: at(createdCases, i).id,
        sessionId: entry.sessionId,
      });
    }
  }
  await db.insert(supportCaseSessions).values(caseSessionRows);
  console.log(`  ${String(caseSessionRows.length)} support case session links created.`);

  // Add messages to each case
  const messageRows: Array<{
    caseId: string;
    senderType: 'driver' | 'operator' | 'system';
    body: string;
    isInternal: boolean;
    createdAt: Date;
  }> = [];
  const driverMessages = [
    'Please look into this issue. I have been waiting for a resolution.',
    'Any update on my case?',
    'I attached a screenshot of the error I received.',
    'This is the third time this has happened.',
    'Thank you for looking into this.',
  ];
  const operatorMessages = [
    'Thank you for reporting this issue. We are investigating.',
    'We have identified the problem and are working on a fix.',
    'Could you provide your transaction ID for reference?',
    'We have processed your refund. It should appear within 3-5 business days.',
    'I have escalated this to our technical team.',
  ];

  for (let i = 0; i < createdCases.length; i++) {
    const caseDate = caseRows[i]?.createdAt ?? new Date();
    const caseId = at(createdCases, i).id;
    const numMessages = randomInt(2, 4);

    for (let m = 0; m < numMessages; m++) {
      const isDriver = m % 2 === 0;
      messageRows.push({
        caseId,
        senderType: isDriver ? 'driver' : 'operator',
        body: isDriver ? pick(driverMessages) : pick(operatorMessages),
        isInternal: false,
        createdAt: new Date(caseDate.getTime() + (m + 1) * randomInt(3600000, 86400000)),
      });
    }

    // Add a system message for status change on some cases
    if (i % 3 === 0) {
      messageRows.push({
        caseId,
        senderType: 'system',
        body: `Status changed to ${caseStatuses[i] ?? 'open'}`,
        isInternal: false,
        createdAt: new Date(caseDate.getTime() + 2 * 86400000),
      });
    }
  }
  await db.insert(supportCaseMessages).values(messageRows);
  console.log(`  ${String(messageRows.length)} support case messages created.`);

  // ------ OCPI Simulator Partner ------
  // Pre-seeds a partner record for the ocpi-simulator (NL/SIM, eMSP role).
  // The registration token 'ocpi-sim-reg-token' lets the simulator complete the
  // credentials handshake. Set OCPI_REGISTRATION_TOKEN=ocpi-sim-reg-token in
  // the simulator's env and point OCPI_TARGET_URL at the OCPI server.
  const SIM_REG_TOKEN = 'ocpi-sim-reg-token';
  const simTokenHash = await argon2.hash(SIM_REG_TOKEN);
  const [simPartner] = await db
    .insert(ocpiPartners)
    .values({
      name: 'OCPI Simulator (eMSP)',
      countryCode: 'NL',
      partyId: 'SIM',
      roles: ['EMSP'],
      ourRoles: ['CPO'],
      status: 'pending',
      version: '2.2.1',
      versionUrl: 'http://localhost:7105/ocpi/versions',
    })
    .returning({ id: ocpiPartners.id });

  if (simPartner == null) throw new Error('Failed to create OCPI simulator partner');

  // Registration token: partnerId is null until the handshake completes.
  // handleRegistration will match the partner by country_code/party_id and deactivate this token.
  await db.insert(ocpiCredentialsTokens).values({
    partnerId: null,
    tokenHash: simTokenHash,
    tokenPrefix: SIM_REG_TOKEN.slice(0, 8),
    direction: 'issued',
    isActive: true,
  });

  // Pre-seed the endpoints the simulator will advertise once registered
  const simBase = 'http://localhost:7105/ocpi/2.2.1';
  await db.insert(ocpiPartnerEndpoints).values([
    {
      partnerId: simPartner.id,
      module: 'tokens',
      interfaceRole: 'SENDER',
      url: `${simBase}/emsp/tokens`,
    },
    {
      partnerId: simPartner.id,
      module: 'sessions',
      interfaceRole: 'RECEIVER',
      url: `${simBase}/emsp/sessions`,
    },
    {
      partnerId: simPartner.id,
      module: 'cdrs',
      interfaceRole: 'RECEIVER',
      url: `${simBase}/emsp/cdrs`,
    },
    {
      partnerId: simPartner.id,
      module: 'commands',
      interfaceRole: 'SENDER',
      url: `${simBase}/emsp/commands`,
    },
    {
      partnerId: simPartner.id,
      module: 'credentials',
      interfaceRole: 'SENDER',
      url: `${simBase}/credentials`,
    },
    {
      partnerId: simPartner.id,
      module: 'credentials',
      interfaceRole: 'RECEIVER',
      url: `${simBase}/credentials`,
    },
  ]);
  console.log(`  OCPI simulator partner seeded (NL/SIM). Registration token: ${SIM_REG_TOKEN}`);

  // ------ OCPI CPO Simulator Partner ------
  // Pre-seeds a partner record for the CPO simulator (DE/CPO, CPO role).
  // Run with: npm run dev:ocpi-sim-cpo
  // OCPI_SIM_AUTO_SESSION=true triggers the auto-session loop after registration.
  const CPO_SIM_REG_TOKEN = 'ocpi-cpo-sim-reg-token';
  const cpoSimTokenHash = await argon2.hash(CPO_SIM_REG_TOKEN);
  const [cpoSimPartner] = await db
    .insert(ocpiPartners)
    .values({
      name: 'OCPI CPO Simulator',
      countryCode: 'DE',
      partyId: 'CPO',
      roles: ['CPO'],
      ourRoles: ['EMSP'],
      status: 'pending',
      version: '2.2.1',
      versionUrl: 'http://localhost:7106/ocpi/versions',
    })
    .returning({ id: ocpiPartners.id });

  if (cpoSimPartner == null) throw new Error('Failed to create OCPI CPO simulator partner');

  await db.insert(ocpiCredentialsTokens).values({
    partnerId: null,
    tokenHash: cpoSimTokenHash,
    tokenPrefix: CPO_SIM_REG_TOKEN.slice(0, 8),
    direction: 'issued',
    isActive: true,
  });

  const cpoSimBase = 'http://localhost:7106/ocpi/2.2.1';
  await db.insert(ocpiPartnerEndpoints).values([
    {
      partnerId: cpoSimPartner.id,
      module: 'locations',
      interfaceRole: 'SENDER',
      url: `${cpoSimBase}/cpo/locations`,
    },
    {
      partnerId: cpoSimPartner.id,
      module: 'sessions',
      interfaceRole: 'SENDER',
      url: `${cpoSimBase}/cpo/sessions`,
    },
    {
      partnerId: cpoSimPartner.id,
      module: 'cdrs',
      interfaceRole: 'SENDER',
      url: `${cpoSimBase}/cpo/cdrs`,
    },
    {
      partnerId: cpoSimPartner.id,
      module: 'tokens',
      interfaceRole: 'RECEIVER',
      url: `${cpoSimBase}/cpo/tokens`,
    },
    {
      partnerId: cpoSimPartner.id,
      module: 'credentials',
      interfaceRole: 'SENDER',
      url: `${cpoSimBase}/credentials`,
    },
    {
      partnerId: cpoSimPartner.id,
      module: 'credentials',
      interfaceRole: 'RECEIVER',
      url: `${cpoSimBase}/credentials`,
    },
  ]);
  console.log(
    `  OCPI CPO simulator partner seeded (DE/CPO). Registration token: ${CPO_SIM_REG_TOKEN}`,
  );

  // ------ SP3 Test CA Certificate ------
  const seedDir = dirname(fileURLToPath(import.meta.url));
  const testCertsDir = resolve(seedDir, '../../css/test-certs');
  let caCertPem: string;
  try {
    caCertPem = readFileSync(resolve(testCertsDir, 'ca.pem'), 'utf-8');
  } catch {
    console.log('  Skipping SP3 cert seeding: test-certs/ca.pem not found.');
    caCertPem = '';
  }

  if (caCertPem.length > 0) {
    const [caCert] = await db
      .insert(pkiCaCertificates)
      .values({
        certificateType: 'CSMSRootCertificate',
        certificate: caCertPem,
        subject: 'CN=EVtivity Test CA,O=EVtivity Test,C=US',
        issuer: 'CN=EVtivity Test CA,O=EVtivity Test,C=US',
        hashAlgorithm: 'SHA256',
        source: 'seed',
        status: 'active',
      })
      .returning({ id: pkiCaCertificates.id });

    // Insert station certificates for SP3 stations (indices 950-999)
    let clientCertPem: string;
    try {
      clientCertPem = readFileSync(resolve(testCertsDir, 'client.pem'), 'utf-8');
    } catch {
      clientCertPem = '';
    }

    if (clientCertPem.length > 0 && caCert != null) {
      const sp3Stations = createdStations.slice(950, 1000);
      const certRows = sp3Stations.map((station) => ({
        stationId: station.id,
        certificateType: 'ChargingStationCertificate',
        certificate: clientCertPem,
        subject: 'CN=SP3 Test Client,O=EVtivity Test,C=US',
        issuer: 'CN=EVtivity Test CA,O=EVtivity Test,C=US',
        hashAlgorithm: 'SHA256',
        parentCaId: caCert.id,
        source: 'seed',
        status: 'active' as const,
      }));
      await db.insert(stationCertificates).values(certRows);
      console.log(`  ${String(sp3Stations.length)} SP3 station certificates created.`);
    }

    console.log('  SP3 test CA certificate seeded.');
  }

  // ------ Portal Test Driver Data ------
  // Sessions, payments, notifications, vehicle, and RFID tokens for the portal test driver
  const portalDriverId = portalTestDriver.id;
  const portalSessionRows: Array<{
    stationId: string;
    siteId: string;
    evseId: string;
    driverId: string;
    transactionId: string;
    status: 'completed';
    startedAt: Date;
    endedAt: Date;
    meterStart: number;
    meterStop: number;
    energyDeliveredWh: string;
    finalCostCents: number;
    currency: string;
    stoppedReason: string;
  }> = [];

  for (let i = 0; i < 22; i++) {
    let year: number;
    let month: number;
    let day: number;
    if (i < 7) {
      year = 2025;
      month = 11; // Dec 2025 (0-indexed)
      day = i * 4 + 1;
    } else if (i < 14) {
      year = 2026;
      month = 0; // Jan 2026
      day = (i - 7) * 4 + 1;
    } else {
      year = 2026;
      month = 1; // Feb 2026
      day = (i - 14) * 3 + 1;
    }

    const startedAt = new Date(Date.UTC(year, month, day, 18 + (i % 6)));
    const endedAt = new Date(startedAt.getTime() + (30 + ((i * 7) % 90)) * 60 * 1000);
    const energyWh = 5000 + i * 1500;
    const costCents = 200 + i * 150;
    const stationIdx = i % createdStations.length;
    const station = at(createdStations, stationIdx);
    const stationEvses = createdEvses.filter((e) => e.stationId === station.id);
    const evse = stationEvses.length > 0 ? at(stationEvses, 0) : at(createdEvses, 0);

    portalSessionRows.push({
      stationId: station.id,
      siteId: at(createdSites, stationIdx % createdSites.length).id,
      evseId: evse.id,
      driverId: portalDriverId,
      transactionId: `txn_portal_${String(i + 1).padStart(3, '0')}`,
      status: 'completed',
      startedAt,
      endedAt,
      meterStart: i * 10000,
      meterStop: i * 10000 + energyWh,
      energyDeliveredWh: String(energyWh),
      finalCostCents: costCents,
      currency: 'USD',
      stoppedReason: 'EVDisconnected',
    });
  }

  const portalCreatedSessions = await db
    .insert(chargingSessions)
    .values(portalSessionRows)
    .returning({ id: chargingSessions.id });

  // Portal driver payments
  const portalPaymentRows = portalCreatedSessions.map((session, i) => ({
    sessionId: session.id,
    driverId: portalDriverId,
    stripePaymentIntentId: `pi_portal_${padNum(i + 1, 4)}`,
    stripeCustomerId: 'cus_U443UCZOsb72EL',
    paymentSource: 'stripe' as const,
    currency: 'USD',
    preAuthAmountCents: 5000,
    capturedAmountCents: portalSessionRows[i]?.finalCostCents ?? 200,
    refundedAmountCents: 0,
    status: 'captured' as const,
  }));
  await db.insert(paymentRecords).values(portalPaymentRows);

  // Portal driver payment method
  await db.insert(driverPaymentMethods).values({
    driverId: portalDriverId,
    stripeCustomerId: 'cus_U443UCZOsb72EL',
    stripePaymentMethodId: 'pm_portal_test',
    cardBrand: 'visa',
    cardLast4: '4242',
    isDefault: true,
  });
  console.log('  Portal test driver payment method created.');

  // Portal driver notifications
  const now = new Date();
  await db.insert(notifications).values([
    {
      eventType: 'session.Completed',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Charging session complete',
      body: 'Your session has ended.',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 1 * 3600000),
    },
    {
      eventType: 'session.Started',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Charging started',
      body: 'Your vehicle is now charging.',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 2 * 3600000),
    },
    {
      eventType: 'payment.Complete',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Payment received',
      body: 'Payment of $5.00 captured.',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 3 * 3600000),
    },
    {
      eventType: 'session.Completed',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Session complete',
      body: 'Charged 12.5 kWh.',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 24 * 3600000),
    },
    {
      eventType: 'session.Receipt',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Receipt available',
      body: 'Your receipt is ready.',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 24 * 3600000),
    },
    {
      eventType: 'session.Started',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Charging started',
      body: 'Session started at Station A.',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 72 * 3600000),
    },
    {
      eventType: 'payment.Complete',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Payment processed',
      body: 'Payment of $8.25 captured.',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 96 * 3600000),
    },
    {
      eventType: 'driver.Welcome',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Welcome to EVtivity',
      body: 'Thanks for signing up!',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 30 * 24 * 3600000),
    },
    {
      eventType: 'session.Completed',
      channel: 'email',
      recipient: 'driver@evtivity.local',
      subject: 'Session ended',
      body: 'Your session is complete.',
      status: 'sent',
      metadata: { driverId: portalDriverId },
      createdAt: new Date(now.getTime() - 120 * 3600000),
    },
  ]);

  // Portal driver vehicle
  await db.insert(vehicles).values({
    driverId: portalDriverId,
    make: 'Tesla',
    model: 'Model 3',
    year: '2024',
  });

  // Portal driver RFID tokens
  await db.insert(driverTokens).values([
    {
      driverId: portalDriverId,
      idToken: 'RFID1234ABCD',
      tokenType: 'ISO14443',
      isActive: true,
    },
    {
      driverId: portalDriverId,
      idToken: 'RFID5678EFGH',
      tokenType: 'ISO14443',
      isActive: false,
    },
  ]);

  // Portal driver favorite stations (first 3 stations)
  const favoriteStations = createdStations.slice(0, 3);
  if (favoriteStations.length > 0) {
    await db
      .insert(driverFavoriteStations)
      .values(favoriteStations.map((s) => ({ driverId: portalDriverId, stationId: s.id })))
      .onConflictDoNothing();
  }

  console.log(
    `  Portal test driver data: ${String(portalCreatedSessions.length)} sessions, ${String(portalPaymentRows.length)} payments, 10 notifications, 1 vehicle, 2 RFID tokens, ${String(favoriteStations.length)} favorites.`,
  );

  // ------ Firmware Campaigns (4) ------
  const fwCampaignDefs: Array<{
    name: string;
    firmwareUrl: string;
    version: string;
    status: 'draft' | 'active' | 'completed' | 'cancelled';
    siteId?: string;
    stationCount: number;
  }> = [
    {
      name: 'v2.5.0 Security Patch',
      firmwareUrl: 'https://firmware.evtivity.com/v2.5.0.bin',
      version: '2.5.0',
      status: 'draft',
      stationCount: 0,
    },
    {
      name: 'v2.4.1 Hotfix',
      firmwareUrl: 'https://firmware.evtivity.com/v2.4.1.bin',
      version: '2.4.1',
      status: 'active',
      siteId: at(createdSites, 0).id,
      stationCount: 50,
    },
    {
      name: 'v2.3.0 Rollout',
      firmwareUrl: 'https://firmware.evtivity.com/v2.3.0.bin',
      version: '2.3.0',
      status: 'completed',
      stationCount: 80,
    },
    {
      name: 'v2.2.0 Beta',
      firmwareUrl: 'https://firmware.evtivity.com/v2.2.0-beta.bin',
      version: '2.2.0-beta',
      status: 'cancelled',
      stationCount: 30,
    },
  ];

  const createdCampaigns = await db
    .insert(firmwareCampaigns)
    .values(
      fwCampaignDefs.map((c) => ({
        name: c.name,
        firmwareUrl: c.firmwareUrl,
        version: c.version,
        status: c.status,
        targetFilter: c.siteId != null ? { siteId: c.siteId } : null,
      })),
    )
    .returning({ id: firmwareCampaigns.id });

  const fwStationStatuses: Array<
    'pending' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'failed'
  > = ['pending', 'downloading', 'downloaded', 'installing', 'installed', 'failed'];

  const fwStationRows: Array<{
    campaignId: string;
    stationId: string;
    status: 'pending' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'failed';
    errorInfo: string | null;
  }> = [];

  for (let ci = 0; ci < createdCampaigns.length; ci++) {
    const campaign = createdCampaigns[ci];
    const def = fwCampaignDefs[ci];
    if (campaign == null || def == null || def.stationCount === 0) continue;
    const stationPool = createdStations.slice(0, def.stationCount);
    for (const station of stationPool) {
      const status =
        def.status === 'completed'
          ? Math.random() > 0.1
            ? 'installed'
            : 'failed'
          : def.status === 'active'
            ? pick(fwStationStatuses)
            : 'pending';
      fwStationRows.push({
        campaignId: campaign.id,
        stationId: station.id,
        status,
        errorInfo: status === 'failed' ? 'Firmware verification failed' : null,
      });
    }
  }

  if (fwStationRows.length > 0) {
    await db.insert(firmwareCampaignStations).values(fwStationRows);
  }
  console.log(
    `  ${String(createdCampaigns.length)} firmware campaigns created (${String(fwStationRows.length)} station assignments).`,
  );

  // ------ Config Templates (3) with Pushes ------
  const configTemplateDefs = [
    {
      name: 'Standard OCPP 2.1 Config',
      description: 'Default configuration for all OCPP 2.1 stations',
      ocppVersion: '2.1' as const,
      variables: [
        { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', value: '300' },
        { component: 'SampledDataCtrlr', variable: 'TxUpdatedInterval', value: '60' },
        { component: 'AuthCtrlr', variable: 'LocalPreAuthorize', value: 'true' },
      ],
      pushCount: 2,
      stationsPerPush: 40,
    },
    {
      name: 'High-Traffic Site Config',
      description: 'Optimized settings for busy locations',
      ocppVersion: '2.1' as const,
      variables: [
        { component: 'OCPPCommCtrlr', variable: 'HeartbeatInterval', value: '120' },
        { component: 'SampledDataCtrlr', variable: 'TxUpdatedInterval', value: '30' },
        { component: 'TxCtrlr', variable: 'StopTxOnInvalidId', value: 'true' },
      ],
      targetFilter: { siteId: at(createdSites, 1).id },
      pushCount: 1,
      stationsPerPush: 25,
    },
    {
      name: 'OCPP 1.6 Legacy Config',
      description: 'Configuration for OCPP 1.6 stations',
      ocppVersion: '1.6' as const,
      variables: [
        { component: '', variable: 'HeartbeatInterval', value: '300' },
        { component: '', variable: 'MeterValueSampleInterval', value: '60' },
        { component: '', variable: 'LocalPreAuthorize', value: 'true' },
      ],
      pushCount: 1,
      stationsPerPush: 30,
    },
  ];

  const createdConfigTemplates = await db
    .insert(configTemplates)
    .values(
      configTemplateDefs.map((t) => ({
        name: t.name,
        description: t.description,
        ocppVersion: t.ocppVersion,
        variables: t.variables,
        targetFilter: t.targetFilter ?? null,
      })),
    )
    .returning({ id: configTemplates.id });

  const pushStationStatuses: Array<'pending' | 'accepted' | 'rejected' | 'failed'> = [
    'accepted',
    'accepted',
    'accepted',
    'accepted',
    'rejected',
    'failed',
  ];

  let totalPushes = 0;
  let totalPushStations = 0;

  for (let ti = 0; ti < createdConfigTemplates.length; ti++) {
    const template = createdConfigTemplates[ti];
    const def = configTemplateDefs[ti];
    if (template == null || def == null) continue;

    for (let pi = 0; pi < def.pushCount; pi++) {
      const stationPool = createdStations.slice(
        pi * def.stationsPerPush,
        (pi + 1) * def.stationsPerPush,
      );
      const isCompleted = pi < def.pushCount - 1;

      const [push] = await db
        .insert(configTemplatePushes)
        .values({
          templateId: template.id,
          status: isCompleted ? 'completed' : 'active',
          stationCount: stationPool.length,
        })
        .returning({ id: configTemplatePushes.id });

      if (push != null && stationPool.length > 0) {
        const pushStationRows = stationPool.map((station) => {
          const status = isCompleted ? pick(pushStationStatuses) : 'pending';
          return {
            pushId: push.id,
            stationId: station.id,
            status,
            errorInfo: status === 'failed' ? 'Station offline' : null,
          };
        });
        await db.insert(configTemplatePushStations).values(pushStationRows);
        totalPushStations += pushStationRows.length;
      }
      totalPushes++;
    }
  }

  console.log(
    `  ${String(createdConfigTemplates.length)} config templates created (${String(totalPushes)} pushes, ${String(totalPushStations)} push station records).`,
  );

  // ------ Smart Charging Profile Templates ------
  const chargingProfileTemplateDefs = [
    {
      name: 'Off-Peak Charging Schedule',
      ocppVersion: '2.1',
      profilePurpose: 'ChargingStationMaxProfile',
      profileKind: 'Recurring',
      recurrencyKind: 'Daily',
      profileId: 100,
      stackLevel: 0,
      evseId: 0,
      chargingRateUnit: 'W',
      schedulePeriods: [
        { startPeriod: 0, limit: 22000 },
        { startPeriod: 21600, limit: 7400 },
        { startPeriod: 32400, limit: 11000 },
        { startPeriod: 61200, limit: 7400 },
        { startPeriod: 75600, limit: 22000 },
      ],
      duration: 86400,
      startSchedule: new Date('2026-01-01T00:00:00Z'),
    },
    {
      name: 'Weekend Full Power',
      ocppVersion: '2.1',
      profilePurpose: 'ChargingStationMaxProfile',
      profileKind: 'Recurring',
      recurrencyKind: 'Weekly',
      profileId: 101,
      stackLevel: 1,
      evseId: 0,
      chargingRateUnit: 'W',
      schedulePeriods: [
        { startPeriod: 0, limit: 11000 },
        { startPeriod: 432000, limit: 50000 },
      ],
      duration: 604800,
      startSchedule: new Date('2026-01-05T00:00:00Z'),
    },
    {
      name: 'Fleet Default 7kW',
      ocppVersion: '1.6',
      profilePurpose: 'TxDefaultProfile',
      profileKind: 'Absolute',
      recurrencyKind: null,
      profileId: 102,
      stackLevel: 0,
      evseId: 0,
      chargingRateUnit: 'W',
      schedulePeriods: [{ startPeriod: 0, limit: 7400 }],
      duration: null,
      startSchedule: null,
    },
  ];

  const existingProfileTemplates = await db
    .select({ id: chargingProfileTemplates.id })
    .from(chargingProfileTemplates);

  if (existingProfileTemplates.length === 0) {
    await db.insert(chargingProfileTemplates).values(
      chargingProfileTemplateDefs.map((t) => ({
        name: t.name,
        ocppVersion: t.ocppVersion,
        profilePurpose: t.profilePurpose,
        profileKind: t.profileKind,
        recurrencyKind: t.recurrencyKind,
        profileId: t.profileId,
        stackLevel: t.stackLevel,
        evseId: t.evseId,
        chargingRateUnit: t.chargingRateUnit,
        schedulePeriods: t.schedulePeriods,
        duration: t.duration,
        startSchedule: t.startSchedule,
      })),
    );
    console.log(
      `  ${String(chargingProfileTemplateDefs.length)} smart charging profile templates created.`,
    );
  } else {
    console.log('  Smart charging profile templates already exist, skipping.');
  }

  // ------ Dashboard Snapshots ------
  const snapshotRows: Array<typeof dashboardSnapshots.$inferInsert> = [];
  const today = new Date();
  const snapshotDays = 14;
  for (const site of createdSites) {
    for (let i = 1; i <= snapshotDays; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0] ?? '';
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
      snapshotRows.push({
        siteId: site.id,
        snapshotDate: dateStr,
        totalStations,
        onlineStations,
        onlinePercent: String(onlinePercent),
        uptimePercent: String(uptimePercent),
        activeSessions: Math.floor(Math.random() * 5),
        totalEnergyWh: String(totalEnergyWh),
        dayEnergyWh: String(dayEnergyWh),
        totalSessions,
        daySessions,
        connectedStations: onlineStations,
        totalRevenueCents,
        dayRevenueCents,
        avgRevenueCentsPerSession: avgRevPerSession,
        totalTransactions,
        dayTransactions,
        totalPorts,
        stationsBelowThreshold,
      });
    }
  }
  if (snapshotRows.length > 0) {
    await db.insert(dashboardSnapshots).values(snapshotRows);
  }
  console.log(
    `  ${String(snapshotRows.length)} dashboard snapshots created (${String(snapshotDays)} days x ${String(createdSites.length)} sites).`,
  );

  // ------ Carbon Intensity Factors ------
  const { seedCarbonIntensityFactors } = await import('./seed-carbon.js');
  const carbonCount = await seedCarbonIntensityFactors();
  console.log(`  ${String(carbonCount)} carbon intensity factors seeded.`);

  // Assign a US carbon region to all sites that don't have one
  const usRegions = await db
    .select({ regionCode: carbonIntensityFactors.regionCode })
    .from(carbonIntensityFactors)
    .where(eq(carbonIntensityFactors.countryCode, 'US'));
  if (usRegions.length > 0) {
    for (let i = 0; i < createdSites.length; i++) {
      const region = usRegions[i % usRegions.length];
      if (region != null) {
        await db
          .update(sites)
          .set({ carbonRegionCode: region.regionCode })
          .where(eq(sites.id, createdSites[i]?.id ?? ''));
      }
    }
    console.log(`  ${String(createdSites.length)} sites assigned carbon regions.`);
  }

  // Backfill CO2 avoided on completed sessions with energy data
  const sessionsToBackfill = await db
    .select({
      id: chargingSessions.id,
      energyDeliveredWh: chargingSessions.energyDeliveredWh,
      carbonIntensityKgPerKwh: carbonIntensityFactors.carbonIntensityKgPerKwh,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .innerJoin(sites, eq(chargingStations.siteId, sites.id))
    .innerJoin(
      carbonIntensityFactors,
      eq(sites.carbonRegionCode, carbonIntensityFactors.regionCode),
    )
    .where(
      and(isNotNull(chargingSessions.energyDeliveredWh), isNull(chargingSessions.co2AvoidedKg)),
    );

  let co2BackfillCount = 0;
  for (const session of sessionsToBackfill) {
    {
      const co2 = calculateCo2AvoidedKg(
        Number(session.energyDeliveredWh),
        Number(session.carbonIntensityKgPerKwh),
      );
      await db
        .update(chargingSessions)
        .set({ co2AvoidedKg: String(co2) })
        .where(eq(chargingSessions.id, session.id));
      co2BackfillCount++;
    }
  }
  console.log(`  ${String(co2BackfillCount)} sessions backfilled with CO2 avoided.`);

  // ------ Summary ------
  console.log('\nSeed complete. Summary:');
  console.log('  45 settings');
  console.log(`  ${String(createdSites.length)} sites`);
  console.log(`  ${String(createdVendors.length)} vendors`);
  console.log(`  ${String(createdStations.length)} charging stations`);
  console.log(`  ${String(powerLimitRows.length)} site power limits`);
  console.log(`  ${String(createdEvses.length)} EVSEs`);
  console.log(`  ${String(connectorRows.length)} connectors`);
  console.log('  3 roles');
  console.log(`  ${String(userRows.length)} users`);
  console.log(`  ${String(createdDrivers.length)} drivers`);
  console.log(`  ${String(tokenRows.length)} driver tokens`);
  console.log(`  ${String(vehicleRows.length)} vehicles`);
  console.log(`  ${String(createdFleets.length)} fleets`);
  console.log(`  ${String(fleetDriverRows.length)} fleet-driver assignments`);
  console.log(`  ${String(fleetStationRows.length)} fleet-station assignments`);
  console.log(`  ${String(holidayRows.length)} pricing holidays`);
  console.log(`  ${String(createdPricingGroups.length)} pricing groups`);
  console.log(`  ${String(tariffRows.length)} tariffs`);
  console.log(`  ${String(pgStationRows.length)} pricing-station assignments`);
  console.log(`  ${String(pgFleetRows.length)} pricing-fleet assignments`);
  console.log(`  ${String(createdSessions.length)} charging sessions`);
  console.log(`  ${String(eventRows.length)} transaction events`);
  console.log(`  ${String(meterValueRows.length)} meter values`);
  console.log(`  ${String(reservationRows.length)} reservations`);
  console.log(`  ${String(paymentRecordRows.length)} payment records`);
  console.log(`  ${String(createdCases.length)} support cases`);
  console.log(`  ${String(caseSessionRows.length)} support case session links`);
  console.log(`  ${String(messageRows.length)} support case messages`);
  console.log(
    `  ${String(createdCampaigns.length)} firmware campaigns (${String(fwStationRows.length)} station assignments)`,
  );
  console.log(
    `  ${String(createdConfigTemplates.length)} config templates (${String(totalPushes)} pushes, ${String(totalPushStations)} push stations)`,
  );
  console.log(
    '  2 OCPI simulator partners (NL/SIM token: ocpi-sim-reg-token, DE/CPO token: ocpi-cpo-sim-reg-token)',
  );
  console.log(`  ${String(snapshotRows.length)} dashboard snapshots`);

  await client.end();
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
