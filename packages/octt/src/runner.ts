// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import pino from 'pino';
import { db, chargingStations, drivers, driverTokens } from '@evtivity/database';
import { refreshTokens, roles, users, OCTT_API_KEY_NAME } from '@evtivity/database';
import { createId } from '@evtivity/database/src/lib/id.js';
import { and, asc, like, eq, sql } from 'drizzle-orm';

import type {
  RunConfig,
  RunSummary,
  TestCaseResult,
  TestCase,
  TriggerCommandFn,
  CallApiFn,
} from './types.js';
import { getRegistry } from './registry.js';
import { executeTest } from './executor.js';
import { createApiClient } from './api-client.js';
import { startOcspTestService, type OcspTestService } from './ocsp-test-service.js';
import { getNotApplicable } from './pics/index.js';

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
    // Remove any OCTT artifacts left over from a previous crashed run.
    await deleteOcttStationsAndArtifacts();
    logger.info('Stations will be auto-provisioned per test');
  }

  // Provision the test driver that owns the per-test tokens (see executeTest)
  let testDriverId = createId('driver');
  let octtPricingGroupId: string | null = null;
  let octtTariffId: string | null = null;
  let pncBackup: { key: string; value: unknown }[] = [];
  if (provisionStations) {
    testDriverId = await provisionTestDriver(testDriverId);
    logger.info('Test driver provisioned');

    // Provision a test pricing group and tariff for TC_I_109 (driver tariff in AuthorizeResponse)
    const ids = await provisionTestTariff(testDriverId);
    octtPricingGroupId = ids.pricingGroupId;
    octtTariffId = ids.tariffId;
    logger.info('Test pricing group and tariff provisioned');

    // Capture prior PnC settings so the run can restore them afterwards.
    pncBackup = (await db.execute(sql`
      SELECT key, value FROM settings WHERE key IN ('pnc.enabled', 'pnc.provider')
    `)) as unknown as { key: string; value: unknown }[];

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
  let callApi: CallApiFn | undefined;
  let apiKeyId: number | undefined;
  let adminUserId: string | undefined;
  let priorAdminAllSiteAccess = false;
  if (config.apiUrl != null) {
    try {
      // Find the first active admin user with all-site access
      const [admin] = await db
        .select({ id: users.id, hasAllSiteAccess: users.hasAllSiteAccess })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(and(eq(users.isActive, true), eq(roles.name, 'admin')))
        .orderBy(asc(users.createdAt))
        .limit(1);
      if (admin != null) {
        // Grant all-site access for OCTT commands, remembering the prior value so
        // it can be restored after the run.
        adminUserId = admin.id;
        priorAdminAllSiteAccess = admin.hasAllSiteAccess;
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
            name: OCTT_API_KEY_NAME,
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
          callApi = apiClient.callApi;
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

  // The Test System OCSP service: a test PKI whose certificates name this
  // responder, for the OCSP-backed certificate tests (TC_C_50/51, TC_M_24).
  let ocsp: OcspTestService | undefined;
  if (config.ocspResponderUrl != null) {
    ocsp = await startOcspTestService(config.ocspResponderUrl);
    logger.info({ url: config.ocspResponderUrl }, 'OCSP test responder started');
    if (callApi != null) {
      ocsp.installedMoRootId = await installMoRoot(callApi, ocsp, logger);
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
    notApplicable: 0,
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
      const promise = processTest(
        testCase,
        config,
        logger,
        summary,
        onResult,
        triggerCommand,
        callApi,
        provisionStations ? testDriverId : undefined,
        ocsp,
      ).then(() => {
        const idx = running.indexOf(promise);
        if (idx !== -1) void running.splice(idx, 1);
      });
      running.push(promise);
    }
    if (running.length > 0) {
      await Promise.race(running);
    }
  }

  summary.durationMs = Date.now() - start;

  if (ocsp?.installedMoRootId != null && callApi != null) {
    const res = await callApi('DELETE', `/pnc/ca-certificates/${String(ocsp.installedMoRootId)}`);
    if (res.status >= 300) {
      logger.warn({ status: res.status }, 'Failed to remove the OCTT MO root certificate');
    }
  }
  await ocsp?.responder.stop();

  // Remove the temporary API key and restore the admin's prior site access.
  if (apiKeyId != null) {
    await db.delete(refreshTokens).where(eq(refreshTokens.id, apiKeyId));
    logger.info('Temporary API key removed');
  }
  if (adminUserId != null && !priorAdminAllSiteAccess) {
    await db.update(users).set({ hasAllSiteAccess: false }).where(eq(users.id, adminUserId));
  }

  // Clean up test driver and tokens (FK is ON DELETE SET NULL, so delete tokens first for clarity)
  if (provisionStations) {
    // Deferred to run end (not per-test) so the OCPP server's async projections
    // finish before the rows are deleted. Removes OCTT stations plus the artifacts
    // that do not cascade from them (CSRs, tariff segments, domain/authorize logs).
    await deleteOcttStationsAndArtifacts();
    logger.info('OCTT test stations cleaned up');

    // Clean up tariff and pricing group (cascade deletes handle child records)
    if (octtTariffId != null) {
      await db.execute(sql`DELETE FROM tariffs WHERE id = ${octtTariffId}`);
    }
    if (octtPricingGroupId != null) {
      await db.execute(sql`DELETE FROM pricing_groups WHERE id = ${octtPricingGroupId}`);
    }
    await db.delete(driverTokens).where(eq(driverTokens.driverId, testDriverId));
    await db.delete(drivers).where(eq(drivers.id, testDriverId));

    // Restore the PnC settings overwritten for the certificate tests.
    await restorePncSettings(pncBackup);
    logger.info('Test driver, tokens, tariff, and PnC settings cleaned up');
  }

  return summary;
}

/** Subject CN of the Test System MO root (see OcttTestPki). */
const OCTT_MO_ROOT_CN = 'CN=OCTT MO Root CA';

type ApiResult = Awaited<ReturnType<CallApiFn>>;

/**
 * Calls a PnC certificate route. The API caches pnc.enabled for up to 60 s,
 * so a PNC_DISABLED answer right after the runner enabled PnC is retried.
 */
async function callPncApi(
  callApi: CallApiFn,
  method: Parameters<CallApiFn>[0],
  path: string,
  body?: Record<string, unknown>,
): Promise<ApiResult> {
  const deadline = Date.now() + 70_000;
  for (;;) {
    const res = await callApi(method, path, body);
    if (res.body['code'] !== 'PNC_DISABLED' || Date.now() > deadline) return res;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/**
 * Deletes Test System MO roots a crashed run left in the CSMS, through the
 * same product routes an operator uses.
 */
async function deleteLeftoverMoRoots(callApi: CallApiFn, logger: pino.Logger): Promise<void> {
  const leftover: number[] = [];
  for (let page = 1; ; page++) {
    const res = await callPncApi(
      callApi,
      'GET',
      `/pnc/ca-certificates?certificateType=MORootCertificate&limit=100&page=${String(page)}`,
    );
    const rows = Array.isArray(res.body['data'])
      ? (res.body['data'] as Record<string, unknown>[])
      : [];
    if (res.status >= 300) {
      logger.warn({ status: res.status }, 'Could not list CA certificates for OCTT cleanup');
      return;
    }
    for (const row of rows) {
      if (
        typeof row['id'] === 'number' &&
        typeof row['subject'] === 'string' &&
        row['subject'].includes(OCTT_MO_ROOT_CN)
      ) {
        leftover.push(row['id']);
      }
    }
    if (rows.length < 100) break;
  }
  for (const id of leftover) {
    const res = await callPncApi(callApi, 'DELETE', `/pnc/ca-certificates/${String(id)}`);
    if (res.status >= 300) {
      logger.warn({ status: res.status, id }, 'Could not delete a leftover OCTT MO root');
    }
  }
  if (leftover.length > 0) {
    logger.info({ count: leftover.length }, 'Deleted leftover OCTT MO root certificates');
  }
}

/**
 * Configures the Test System MO root in the CSMS the way an operator does
 * (Certificates > Upload CA certificate), so a contract chain sent in
 * AuthorizeRequest.certificate chains to a configured root (TC_C_52).
 */
async function installMoRoot(
  callApi: CallApiFn,
  ocsp: OcspTestService,
  logger: pino.Logger,
): Promise<number | null> {
  await deleteLeftoverMoRoots(callApi, logger);
  const res = await callPncApi(callApi, 'POST', '/pnc/ca-certificates', {
    certificateType: 'MORootCertificate',
    certificate: ocsp.pki.moRoot.cert.toString('pem'),
  });
  if (res.status < 300 && typeof res.body['id'] === 'number') {
    logger.info('OCTT MO root certificate installed in the CSMS');
    return res.body['id'];
  }
  logger.warn({ status: res.status, body: res.body }, 'Could not install the OCTT MO root');
  return null;
}

async function deleteOcttStationsAndArtifacts(): Promise<void> {
  // Rows that do not cascade from the station must be removed first, while the
  // station and session rows still exist to identify them: session_tariff_segments
  // has no session FK, and pki_csr_requests is ON DELETE SET NULL.
  await db.execute(sql`
    DELETE FROM session_tariff_segments
    WHERE session_id IN (
      SELECT cs.id FROM charging_sessions cs
      JOIN charging_stations st ON st.id = cs.station_id
      WHERE st.station_id LIKE 'OCTT-%'
    )
  `);
  await db.execute(sql`
    DELETE FROM pki_csr_requests
    WHERE station_id IN (SELECT id FROM charging_stations WHERE station_id LIKE 'OCTT-%')
  `);
  // Keyed by the OCPP station id string / aggregate id (no FK), removable directly.
  await db.execute(sql`DELETE FROM authorize_attempts WHERE station_id LIKE 'OCTT-%'`);
  await db.execute(sql`DELETE FROM domain_events WHERE aggregate_id LIKE 'OCTT-%'`);
  // Cascade clears evses, connectors, sessions, projection rows, and station certs.
  await db.delete(chargingStations).where(like(chargingStations.stationId, 'OCTT-%'));
}

async function restorePncSettings(backup: { key: string; value: unknown }[]): Promise<void> {
  const saved = new Map(backup.map((row) => [row.key, row.value]));
  for (const key of ['pnc.enabled', 'pnc.provider']) {
    if (saved.has(key)) {
      const value = JSON.stringify(saved.get(key) ?? null);
      await db.execute(sql`UPDATE settings SET value = ${value}::jsonb WHERE key = ${key}`);
    } else {
      await db.execute(sql`DELETE FROM settings WHERE key = ${key}`);
    }
  }
}

async function provisionTestDriver(driverId: string): Promise<string> {
  // Check for an existing OCTT test driver (from a previous run) to avoid
  // the email partial-unique-index conflict that silently skips the insert
  // and leaves us with a driverId that doesn't exist.
  const existing = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(eq(drivers.email, 'octt-test@evtivity.local'))
    .limit(1);

  const existingId = existing[0]?.id;
  if (existingId != null) {
    // Tokens left over from a crashed run are not used by any test.
    await db.delete(driverTokens).where(eq(driverTokens.driverId, existingId));
    return existingId;
  }

  await db.insert(drivers).values({
    id: driverId,
    firstName: 'OCTT',
    lastName: 'Test Driver',
    email: 'octt-test@evtivity.local',
  });
  return driverId;
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
  // energy: 0.25/kWh, idle: 0.10/min, fixed: 0.50, tax: 20% VAT (tax_rate is a fraction)
  await db.execute(sql`
    INSERT INTO tariffs (id, pricing_group_id, name, price_per_kwh, price_per_minute,
                         price_per_session, idle_fee_price_per_minute, tax_rate, is_active, priority, is_default)
    VALUES (${tariffId}, ${pricingGroupId}, 'OCTT Test Tariff', '0.25', '0.00',
            '0.50', '0.10', '0.20', true, 0, true)
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
  callApi?: CallApiFn,
  testDriverId?: string,
  ocsp?: OcspTestService,
): Promise<void> {
  // Real OCTT runs only the tests the CSMS PICS makes applicable: report the
  // others notApplicable without provisioning a station or executing them.
  const notApplicable = getNotApplicable(testCase.id, testCase.version, 'csms');
  const result: TestCaseResult =
    notApplicable == null
      ? await executeTest(testCase, config, logger, triggerCommand, callApi, testDriverId, ocsp)
      : {
          testId: testCase.id,
          testName: testCase.name,
          module: testCase.module,
          version: testCase.version,
          result: { status: 'notApplicable', durationMs: 0, steps: [], notApplicable },
        };

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
    case 'notApplicable':
      summary.notApplicable++;
      break;
  }

  onResult(result);
}
