// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import pino from 'pino';
import { db, chargingStations, drivers, driverTokens } from '@evtivity/database';
import { refreshTokens, users } from '@evtivity/database';
import { createId } from '@evtivity/database/src/lib/id.js';
import { like, inArray, eq, sql } from 'drizzle-orm';

import type { RunConfig, RunSummary, TestCaseResult, TestCase, TriggerCommandFn } from './types.js';
import { getRegistry } from './registry.js';
import { executeTest } from './executor.js';
import { createApiClient } from './api-client.js';

const DEFAULT_CONCURRENCY = 3;

export async function runTests(
  config: RunConfig,
  onResult: (result: TestCaseResult) => void,
): Promise<RunSummary> {
  const logger = pino({ level: config.logLevel ?? 'info' });
  const allTests = getRegistry();
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;

  const provisionStations = config.provisionStations ?? true;
  if (provisionStations) {
    // Clean up any OCTT stations left over from a previous crashed run
    const stale = await db
      .select({ id: chargingStations.id })
      .from(chargingStations)
      .where(like(chargingStations.stationId, 'OCTT-%'));
    if (stale.length > 0) {
      const staleIds = stale.map((s) => s.id);
      await db.delete(chargingStations).where(inArray(chargingStations.id, staleIds));
    }
    logger.info('Stations will be auto-provisioned per test');
  }

  // Provision a test driver and tokens so Authorize requests return Accepted
  let testDriverId = createId('driver');
  let octtPricingGroupId: string | null = null;
  let octtTariffId: string | null = null;
  if (provisionStations) {
    testDriverId = await provisionTestDriverAndTokens(testDriverId);
    logger.info('Test driver and tokens provisioned');

    // Provision a test pricing group and tariff for TC_I_109 (driver tariff in AuthorizeResponse)
    const ids = await provisionTestTariff(testDriverId);
    octtPricingGroupId = ids.pricingGroupId;
    octtTariffId = ids.tariffId;
    logger.info('Test pricing group and tariff provisioned');

    // Enable PnC for M-certificate-management tests
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES ('pnc.enabled', 'true'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb
    `);
    // Set provider to manual so certificate signing flows work
    await db.execute(sql`
      INSERT INTO settings (key, value) VALUES ('pnc.provider', '"manual"'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = '"manual"'::jsonb
    `);
    logger.info('PnC enabled for certificate management tests');
  }

  // Create a temporary API key for triggering CSMS-initiated commands
  let triggerCommand: TriggerCommandFn | undefined;
  let apiKeyId: number | undefined;
  if (config.apiUrl != null) {
    try {
      // Find the first active admin user with all-site access
      const [admin] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isActive, true))
        .limit(1);
      if (admin != null) {
        // Ensure the user has all-site access for OCTT commands
        await db.update(users).set({ hasAllSiteAccess: true }).where(eq(users.id, admin.id));
        // Create a temporary API key
        const raw = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
        const [row] = await db
          .insert(refreshTokens)
          .values({
            userId: admin.id,
            tokenHash,
            type: 'api_key' as const,
            name: 'OCTT Runner (temporary)',
          })
          .returning({ id: refreshTokens.id });
        if (row != null) {
          apiKeyId = row.id;
          const apiClient = await createApiClient(config.apiUrl, raw, logger);
          // Verify the API key works by hitting an authenticated endpoint
          const testRes = await fetch(`${config.apiUrl}/v1/settings/system.timezone`, {
            headers: { Authorization: `Bearer ${raw}` },
          });
          if (!testRes.ok) {
            throw new Error(`API key verification failed (${String(testRes.status)})`);
          }
          triggerCommand = apiClient.triggerCommand;
          logger.info(
            'API key created and verified - CSMS-initiated commands will be triggered via REST API',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'API client setup failed - CSMS-initiated tests will timeout',
      );
    }
  }

  const tests = allTests.filter((tc) => {
    if (config.version != null && tc.version !== config.version) return false;
    if (config.sut != null && tc.sut !== config.sut) return false;
    if (config.module != null && tc.module !== config.module) return false;
    if (config.testIds != null && !config.testIds.includes(tc.id)) return false;
    return true;
  });

  const summary: RunSummary = {
    total: tests.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
    durationMs: 0,
  };

  const start = Date.now();

  // Process tests with controlled concurrency
  const queue = [...tests];
  const running: Promise<void>[] = [];

  while (queue.length > 0 || running.length > 0) {
    while (running.length < concurrency && queue.length > 0) {
      const testCase = queue.shift();
      if (testCase == null) break;
      const promise = processTest(testCase, config, logger, summary, onResult, triggerCommand).then(
        () => {
          const idx = running.indexOf(promise);
          if (idx !== -1) void running.splice(idx, 1);
        },
      );
      running.push(promise);
    }
    if (running.length > 0) {
      await Promise.race(running);
    }
  }

  summary.durationMs = Date.now() - start;

  // Clean up temporary API key
  if (apiKeyId != null) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, apiKeyId));
    logger.info('Temporary API key revoked');
  }

  // Clean up test driver and tokens (FK is ON DELETE SET NULL, so delete tokens first for clarity)
  if (provisionStations) {
    // Clean up tariff and pricing group (cascade deletes handle child records)
    if (octtTariffId != null) {
      await db.execute(sql`DELETE FROM tariffs WHERE id = ${octtTariffId}`);
    }
    if (octtPricingGroupId != null) {
      await db.execute(sql`DELETE FROM pricing_groups WHERE id = ${octtPricingGroupId}`);
    }
    await db.delete(driverTokens).where(eq(driverTokens.driverId, testDriverId));
    await db.delete(drivers).where(eq(drivers.id, testDriverId));
    logger.info('Test driver, tokens, and tariff cleaned up');
  }

  return summary;
}

const OCTT_TEST_TOKENS = [
  // Active tokens used by various OCTT test modules
  { idToken: 'OCTT_TAG_001', tokenType: 'ISO14443', isActive: true },
  { idToken: 'OCTT-TOKEN-001', tokenType: 'ISO14443', isActive: true },
  { idToken: 'OCTT-TOKEN-002', tokenType: 'ISO14443', isActive: true },
  { idToken: 'OCTT-TOKEN-01', tokenType: 'ISO14443', isActive: true },
  { idToken: 'OCTT-TOKEN-V2X', tokenType: 'ISO14443', isActive: true },
  // MasterPass tokens for stop-all-transactions tests (TC_C_47, TC_C_49)
  { idToken: 'OCTT-MASTERPASS-001', tokenType: 'ISO14443', isActive: true },
  // Prepaid tokens for payment terminal tests
  { idToken: 'OCTT-PREPAID-001', tokenType: 'ISO14443', isActive: true },
  // Blocked tokens (isActive=false causes authorize handler to return Blocked)
  { idToken: 'BLOCKED_TAG_001', tokenType: 'ISO14443', isActive: false },
  { idToken: 'BLOCKED-TOKEN-99999', tokenType: 'ISO14443', isActive: false },
  // Prepaid no-credit token for TC_C_104
  { idToken: 'OCTT-PREPAID-NOCREDIT', tokenType: 'ISO14443', isActive: true },
  // Expired tokens: set isActive=false so authorize returns Blocked (which
  // OCTT accepts as valid for expired-token test cases alongside Invalid/Expired)
  { idToken: 'EXPIRED_TAG_001', tokenType: 'ISO14443', isActive: false },
  { idToken: 'EXPIRED-TOKEN-99999', tokenType: 'ISO14443', isActive: false },
];

async function provisionTestDriverAndTokens(driverId: string): Promise<string> {
  // Check for an existing OCTT test driver (from a previous run) to avoid
  // the email partial-unique-index conflict that silently skips the insert
  // and leaves us with a driverId that doesn't exist.
  const existing = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(eq(drivers.email, 'octt-test@evtivity.local'))
    .limit(1);

  const resolvedDriverId = existing[0]?.id ?? driverId;

  if (existing.length === 0) {
    await db.insert(drivers).values({
      id: resolvedDriverId,
      firstName: 'OCTT',
      lastName: 'Test Driver',
      email: 'octt-test@evtivity.local',
    });
  }

  for (const token of OCTT_TEST_TOKENS) {
    await db
      .insert(driverTokens)
      .values({
        id: createId('driverToken'),
        driverId: resolvedDriverId,
        idToken: token.idToken,
        tokenType: token.tokenType,
        isActive: token.isActive,
      })
      .onConflictDoNothing();
  }

  return resolvedDriverId;
}

async function provisionTestTariff(
  driverId: string,
): Promise<{ pricingGroupId: string; tariffId: string }> {
  const pricingGroupId = createId('pricingGroup');
  const tariffId = createId('tariff');

  // Create a pricing group for OCTT tests
  await db.execute(sql`
    INSERT INTO pricing_groups (id, name, description, is_default)
    VALUES (${pricingGroupId}, 'OCTT Test Pricing', 'Pricing group for OCTT conformance tests', false)
    ON CONFLICT DO NOTHING
  `);

  // Create a tariff matching TC_I_109 expected values:
  // energy: 0.25/kWh, idle: 0.10/min, fixed: 0.50, tax: 20% VAT
  await db.execute(sql`
    INSERT INTO tariffs (id, pricing_group_id, name, currency, price_per_kwh, price_per_minute,
                         price_per_session, idle_fee_price_per_minute, tax_rate, is_active, priority, is_default)
    VALUES (${tariffId}, ${pricingGroupId}, 'OCTT Test Tariff', 'USD', '0.25', '0.00',
            '0.50', '0.10', '20', true, 0, true)
    ON CONFLICT DO NOTHING
  `);

  // Assign the pricing group to the test driver
  await db.execute(sql`
    INSERT INTO pricing_group_drivers (pricing_group_id, driver_id)
    VALUES (${pricingGroupId}, ${driverId})
    ON CONFLICT DO NOTHING
  `);

  return { pricingGroupId, tariffId };
}

async function processTest(
  testCase: TestCase,
  config: RunConfig,
  logger: pino.Logger,
  summary: RunSummary,
  onResult: (result: TestCaseResult) => void,
  triggerCommand?: TriggerCommandFn,
): Promise<void> {
  const result = await executeTest(testCase, config, logger, triggerCommand);

  switch (result.result.status) {
    case 'passed':
      summary.passed++;
      break;
    case 'failed':
      summary.failed++;
      break;
    case 'skipped':
      summary.skipped++;
      break;
    case 'error':
      summary.errors++;
      break;
  }

  onResult(result);
}
