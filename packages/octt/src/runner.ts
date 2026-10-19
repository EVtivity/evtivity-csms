// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import pino from 'pino';
import {
  db,
  drivers,
  driverTokens,
  deleteConformanceStations,
  deleteConformanceTestDriver,
} from '@evtivity/database';
import { refreshTokens, roles, users, OCTT_API_KEY_NAME } from '@evtivity/database';
import { createId } from '@evtivity/database/src/lib/id.js';
import { OCTT_TEST_DRIVER_EMAIL } from '@evtivity/lib';
import { and, asc, eq, sql } from 'drizzle-orm';

import type {
  RunConfig,
  RunSummary,
  TestCaseResult,
  TestCase,
  TriggerCommandFn,
  CallApiFn,
} from './types.js';
import { getRegistry } from './registry.js';
import { OCTT_THRESHOLD_KWH } from './tariff-test-constants.js';
import { executeTest } from './executor.js';
import { createApiClient } from './api-client.js';
import { startOcspTestService, type OcspTestService } from './ocsp-test-service.js';
import { getNotApplicable } from './pics/index.js';
import {
  PendingSettingsRestore,
  restoreLeftoverRunSettings,
  settingsCacheTtlMs,
  writeSettings,
  type SettingChange,
} from './run-settings.js';

const DEFAULT_CONCURRENCY = 3;
/** Added to the CSMS settings cache TTL before the run relies on a changed setting. */
const SETTINGS_CACHE_MARGIN_MS = 1_000;
/** How long an aborted run waits for its running tests before it cleans up. */
export const RUN_ABORT_WAIT_MS = 10_000;

function settingsEffectiveAt(changes: readonly SettingChange[]): number {
  if (changes.length === 0) return 0;
  return Date.now() + settingsCacheTtlMs(changes.map((c) => c.key)) + SETTINGS_CACHE_MARGIN_MS;
}

/** Resolves when the running tests settle or after `ms`, whichever comes first. */
async function settleWithin(running: Promise<void>[], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(running),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

export async function runTests(
  config: RunConfig,
  onResult: (result: TestCaseResult) => void,
): Promise<RunSummary> {
  const logger = pino({ level: config.logLevel ?? 'info' });
  const signal = config.signal;
  const aborted = (): boolean => signal?.aborted === true;
  const abortSeen = new Promise<void>((resolve) => {
    signal?.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
  const allTests = getRegistry();
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;

  const provisionStations = config.provisionStations ?? true;
  if (provisionStations) {
    // Remove the stations, test driver and pricing group a crashed run left.
    await deleteRunData(logger);
    // Settings a killed run left changed. Two CSMS runs never overlap, so any row is a leftover.
    await bestEffort(logger, 'Failed to restore the settings of an earlier run', () =>
      restoreLeftoverRunSettings(logger),
    );
    logger.info('Stations will be auto-provisioned per test');
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

  // Everything the run changes, undone in the finally block below whatever
  // happens during the run.
  let testDriverId = createId('driver');
  const pendingSettings = new PendingSettingsRestore(logger);
  let triggerCommand: TriggerCommandFn | undefined;
  let callApi: CallApiFn | undefined;
  let apiKeyId: number | undefined;
  let adminUserId: string | undefined;
  let priorAdminAllSiteAccess = false;
  let ocsp: OcspTestService | undefined;

  try {
    // Each CSMS process caches the settings it reads (settingsCacheTtlMs), so a
    // changed value takes effect only after that (see waitForSettings).
    let runSettingsEffectiveAt = 0;
    if (provisionStations) {
      // The test driver that owns the per-test tokens (see executeTest)
      testDriverId = await provisionTestDriver(testDriverId);
      logger.info('Test driver provisioned');

      // A test pricing group and tariff for TC_I_109 (driver tariff in AuthorizeResponse)
      await provisionTestTariff(testDriverId);
      logger.info('Test pricing group and tariff provisioned');

      // PnC on with the local provider (it queues CSRs for signing like the
      // manual provider and issues ISO 15118 contract certificates: TC_M_26,
      // TC_M_28, TC_M_100), the test eMAID prefix unless the operator set one,
      // and the Test System OCSP responder host allowed (TC_C_50/51/52, TC_M_24).
      const runChanges = await applyRunSettings(config.ocspResponderUrl, (change) =>
        pendingSettings.record('run', change),
      );
      runSettingsEffectiveAt = settingsEffectiveAt(runChanges);
      logger.info({ changed: runChanges.map((c) => c.key) }, 'Run settings set');
    }

    // Create a temporary API key for triggering CSMS-initiated commands
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

    // Tests and the MO root upload below need the CSMS to see the settings.
    await waitForSettings(runSettingsEffectiveAt, logger, signal);

    // The local contract CA the contract certificate tests need. Created through
    // the operator route when the CSMS has none; the run end restores the
    // previous setting, which removes it again.
    if (callApi != null && provisionStations && !aborted()) {
      await ensureLocalContractCa(callApi, logger, pendingSettings);
    }

    // The Test System OCSP service: a test PKI whose certificates name this
    // responder, for the OCSP-backed certificate tests (TC_C_50/51, TC_M_24).
    if (config.ocspResponderUrl != null && !aborted()) {
      ocsp = await startOcspTestService(config.ocspResponderUrl);
      logger.info({ url: config.ocspResponderUrl }, 'OCSP test responder started');
      if (callApi != null) {
        ocsp.installedMoRootId = await installMoRoot(callApi, ocsp, logger);
      }
    }

    const start = Date.now();

    // Process tests with controlled concurrency. Cases that need other settings
    // than the run's run afterwards, one at a time, below.
    const queue = tests.filter((tc) => tc.settings == null);
    const running: Promise<void>[] = [];

    while (queue.length > 0 || running.length > 0) {
      if (aborted()) {
        await settleWithin(running, RUN_ABORT_WAIT_MS);
        break;
      }
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
        await Promise.race([...running, abortSeen]);
      }
    }

    let settingsStaleUntil = 0;
    for (const testCase of tests.filter((tc) => tc.settings != null)) {
      if (aborted()) break;
      if (provisionStations && testCase.settings != null) {
        const caseChanges = await applyCaseSettings(testCase.settings, (change) =>
          pendingSettings.record('case', change),
        );
        settingsStaleUntil = Math.max(settingsStaleUntil, settingsEffectiveAt(caseChanges));
        logger.info(
          { testId: testCase.id, changed: caseChanges.map((c) => c.key) },
          'Settings set for one test case',
        );
      } else {
        logger.warn(
          { testId: testCase.id },
          'Test case needs settings the run does not change without station provisioning',
        );
      }
      await waitForSettings(settingsStaleUntil, logger, signal);
      if (aborted()) break;
      await processTest(
        testCase,
        config,
        logger,
        summary,
        onResult,
        triggerCommand,
        callApi,
        provisionStations ? testDriverId : undefined,
        ocsp,
      );
      const restored = [...pendingSettings.caseChanges];
      if (restored.length > 0) {
        await pendingSettings.restoreCase();
        // The next case must not see this case's values from a CSMS cache.
        settingsStaleUntil = Math.max(settingsStaleUntil, settingsEffectiveAt(restored));
      }
    }

    summary.durationMs = Date.now() - start;
    if (aborted()) throw new Error('OCTT run aborted', { cause: signal?.reason });
  } finally {
    pendingSettings.stopHeartbeat();
    if (provisionStations) {
      // First, so a cleanup cut short still leaves the CSMS settings as they were.
      await bestEffort(logger, 'Failed to restore the run settings', async () => {
        await pendingSettings.restoreAll();
        logger.info('Run settings restored');
      });
    }

    // Each step on its own, so a failed one (the CSMS API unreachable at the
    // end) never leaves the test stations, the driver or the settings behind.
    const moRootId = ocsp?.installedMoRootId;
    const api = callApi;
    if (moRootId != null && api != null) {
      await bestEffort(logger, 'Failed to remove the OCTT MO root certificate', async () => {
        const res = await api('DELETE', `/pnc/ca-certificates/${String(moRootId)}`);
        if (res.status >= 300) throw new Error(`status ${String(res.status)}`);
      });
    }
    const responder = ocsp?.responder;
    if (responder != null) {
      await bestEffort(logger, 'Failed to stop the OCSP test responder', () => responder.stop());
    }

    // Remove the temporary API key and restore the admin's prior site access.
    const keyId = apiKeyId;
    if (keyId != null) {
      await bestEffort(logger, 'Failed to remove the temporary API key', async () => {
        await db.delete(refreshTokens).where(eq(refreshTokens.id, keyId));
        logger.info('Temporary API key removed');
      });
    }
    const adminId = adminUserId;
    if (adminId != null && !priorAdminAllSiteAccess) {
      await bestEffort(logger, 'Failed to restore the admin site access', async () => {
        await db.update(users).set({ hasAllSiteAccess: false }).where(eq(users.id, adminId));
      });
    }

    if (provisionStations) {
      // Deferred to run end (not per-test) so the OCPP server's async
      // projections finish before the rows are deleted. A step that fails is
      // retried by the worker sweep (`conformance-station-sweep`).
      await deleteRunData(logger);
    }
  }

  return summary;
}

/** Runs a teardown step, logging a failure at error instead of throwing. */
async function bestEffort(
  logger: pino.Logger,
  message: string,
  step: () => Promise<unknown>,
): Promise<void> {
  try {
    await step();
  } catch (err) {
    logger.error({ err }, message);
  }
}

/**
 * Deletes the CSMS run's test stations (not the CS runner's `OCTT-CS-*`
 * stations: a CS run may be going next to this one and deletes its own),
 * then the test driver, its tokens and its pricing group. Runs at run start
 * (leftovers of a crashed run) and at run end.
 */
async function deleteRunData(logger: pino.Logger): Promise<void> {
  await bestEffort(logger, 'OCTT station cleanup failed', async () => {
    const started = Date.now();
    const stations = await deleteConformanceStations({ includeCs: false });
    logger.info({ stations, durationMs: Date.now() - started }, 'OCTT test stations deleted');
  });
  await bestEffort(logger, 'OCTT test driver cleanup failed', async () => {
    const result = await deleteConformanceTestDriver();
    if (result.detachedRows > 0 || result.pricingGroupsKept > 0) {
      logger.warn(result, 'OCTT test driver deleted; rows outside the run referenced it');
    } else {
      logger.info(result, 'OCTT test driver, tokens and pricing group deleted');
    }
  });
}

/** Subject CN of the Test System MO root (see OcttTestPki). */
const OCTT_MO_ROOT_CN = 'CN=OCTT MO Root CA';

/**
 * Deletes Test System MO roots a crashed run left in the CSMS, through the
 * same product routes an operator uses.
 */
async function deleteLeftoverMoRoots(callApi: CallApiFn, logger: pino.Logger): Promise<void> {
  const leftover: number[] = [];
  for (let page = 1; ; page++) {
    const res = await callApi(
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
    const res = await callApi('DELETE', `/pnc/ca-certificates/${String(id)}`);
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
  const res = await callApi('POST', '/pnc/ca-certificates', {
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

const OCTT_EMAID_COUNTRY = 'US';
const OCTT_EMAID_PROVIDER = 'OCT';

/**
 * Creates the local contract CA through the operator route when the CSMS has
 * none, recording the previous `pnc.local.caEnc` first so the run end (or the
 * next run, after a kill) removes the CA again.
 */
async function ensureLocalContractCa(
  callApi: CallApiFn,
  logger: pino.Logger,
  pendingSettings: PendingSettingsRestore,
): Promise<void> {
  const status = await callApi('GET', '/pnc/settings/local-ca');
  if (status.status >= 300) {
    logger.warn({ status: status.status }, 'Could not read the local contract CA');
    return;
  }
  if (status.body['configured'] === true) return;
  const rows = (await db.execute(sql`
    SELECT value FROM settings WHERE key = 'pnc.local.caEnc'
  `)) as unknown as { value: unknown }[];
  const change: SettingChange = { key: 'pnc.local.caEnc', previous: rows[0]?.value };
  await pendingSettings.record('run', change);
  const created = await callApi('POST', '/pnc/settings/local-ca');
  if (created.status < 300) {
    logger.info('Local contract CA ready for the ISO 15118 contract certificate tests');
    return;
  }
  // Not created by this run: a CA that exists now belongs to someone else.
  await pendingSettings.discard(change);
  if (created.body['code'] === 'LOCAL_CA_EXISTS') {
    logger.info('Local contract CA ready for the ISO 15118 contract certificate tests');
  } else {
    logger.warn({ status: created.status }, 'Could not create the local contract CA');
  }
}

/**
 * Sets what the certificate tests need: PnC on (`pnc.enabled`), the local PKI
 * provider (`pnc.provider`: CSRs queue for the operator to sign through the
 * API, and it issues ISO 15118 contract certificates), the test eMAID prefix
 * when none is set (`pnc.local.emaidCountry`, `pnc.local.emaidProviderId`),
 * and, with an OCSP responder, its host in `pnc.ocsp.allowedPrivateHosts` (the
 * CSMS refuses OCSP requests to private addresses that are not listed). The
 * tariff tests need split billing (`pricing.splitBillingEnabled`), which is
 * on by default; the run leaves the operator's value alone. The ISO 15118
 * smart charging tests (TC_K_53, TC_K_57, TC_K_114, TC_K_115) need the CSMS to
 * provide charging profiles: `smartCharging.iso15118Enabled` is turned on when
 * the operator turned it off (unset or any other value reads as on).
 * Each change goes to `record` before it is written. Returns the settings it changed.
 */
export async function applyRunSettings(
  ocspResponderUrl: string | undefined,
  record: (change: SettingChange) => Promise<void>,
): Promise<SettingChange[]> {
  const rows = (await db.execute(sql`
    SELECT key, value FROM settings
    WHERE key IN ('pnc.enabled', 'pnc.provider', 'pnc.ocsp.allowedPrivateHosts',
      'pnc.local.emaidCountry', 'pnc.local.emaidProviderId', 'smartCharging.iso15118Enabled')
  `)) as unknown as { key: string; value: unknown }[];
  const current = new Map(rows.map((row) => [row.key, row.value]));

  const wanted = new Map<string, unknown>([
    ['pnc.enabled', true],
    ['pnc.provider', 'local'],
  ]);
  if (current.get('smartCharging.iso15118Enabled') === false) {
    wanted.set('smartCharging.iso15118Enabled', true);
  }
  // The eMAID prefix of the test contracts, unless the operator set one.
  for (const [key, value] of [
    ['pnc.local.emaidCountry', OCTT_EMAID_COUNTRY],
    ['pnc.local.emaidProviderId', OCTT_EMAID_PROVIDER],
  ] as const) {
    const set = current.get(key);
    if (typeof set !== 'string' || set === '') wanted.set(key, value);
  }
  if (ocspResponderUrl != null) {
    const host = new URL(ocspResponderUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const hosts = current.get('pnc.ocsp.allowedPrivateHosts');
    const list = Array.isArray(hosts)
      ? hosts.filter((h): h is string => typeof h === 'string')
      : [];
    if (!list.map((h) => h.toLowerCase()).includes(host)) {
      wanted.set('pnc.ocsp.allowedPrivateHosts', [...list, host]);
    }
  }

  return writeSettings(wanted, current, record);
}

/**
 * Sets the settings one test case needs (`TestCase.settings`), such as
 * `smartCharging.iso15118Enabled` off for TC_K_126 (the CSMS turns off
 * providing a charging profile). Each change goes to `record` before it is
 * written. Returns the settings it changed.
 */
export async function applyCaseSettings(
  settings: Record<string, unknown>,
  record: (change: SettingChange) => Promise<void>,
): Promise<SettingChange[]> {
  const current = new Map<string, unknown>();
  for (const key of Object.keys(settings)) {
    const rows = (await db.execute(sql`
      SELECT value FROM settings WHERE key = ${key}
    `)) as unknown as { value: unknown }[];
    if (rows[0] != null) current.set(key, rows[0].value);
  }
  return writeSettings(new Map(Object.entries(settings)), current, record);
}

/**
 * Waits until every CSMS process sees settings the run changed. The OCPP
 * server and the API cache settings per process (settingsCacheTtlMs) and the
 * run cannot clear another process's cache, so a test started earlier can get
 * the old value: SignCertificate for a V2G certificate is Rejected while the
 * OCPP server still has PnC disabled cached (TC_A_12_CSMS failed this way).
 * An aborted run stops waiting.
 */
export async function waitForSettings(
  effectiveAt: number,
  logger: pino.Logger,
  signal?: AbortSignal,
): Promise<void> {
  const waitMs = effectiveAt - Date.now();
  if (waitMs <= 0 || signal?.aborted === true) return;
  logger.info({ waitMs }, 'Waiting for the CSMS settings caches to pick up the changed settings');
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    signal?.addEventListener('abort', done, { once: true });
  });
}

async function provisionTestDriver(driverId: string): Promise<string> {
  // Check for an existing OCTT test driver (from a previous run) to avoid
  // the email partial-unique-index conflict that silently skips the insert
  // and leaves us with a driverId that doesn't exist.
  const existing = await db
    .select({ id: drivers.id })
    .from(drivers)
    .where(eq(drivers.email, OCTT_TEST_DRIVER_EMAIL))
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
    email: OCTT_TEST_DRIVER_EMAIL,
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

  // The default tariff, matching TC_I_109 expected values: energy 0.25/kWh,
  // idle fee 0.10/min, fixed 0.50, reservation 0.05/min, tax 20% VAT
  // (tax_rate is a fraction).
  await db.execute(sql`
    INSERT INTO tariffs (id, pricing_group_id, name, price_per_kwh, price_per_minute,
                         price_per_session, idle_fee_price_per_minute, reservation_fee_per_minute,
                         tax_rate, is_active, priority, is_default)
    VALUES (${tariffId}, ${pricingGroupId}, 'OCTT Test Tariff', '0.25', '0.00',
            '0.50', '0.10', '0.05', '0.20', true, 0, true)
    ON CONFLICT DO NOTHING
  `);
  // An energy-threshold tariff (0.20/kWh from OCTT_THRESHOLD_KWH): with split
  // billing the CSMS sends it as a minEnergy condition (TC_I_109) and moves a
  // session past the threshold to it (TC_I_111).
  await db.execute(sql`
    INSERT INTO tariffs (id, pricing_group_id, name, price_per_kwh, price_per_minute,
                         price_per_session, idle_fee_price_per_minute, reservation_fee_per_minute,
                         tax_rate, restrictions, is_active, priority, is_default)
    VALUES (${createId('tariff')}, ${pricingGroupId}, 'OCTT Bulk Tariff', '0.20', '0.00',
            '0.00', '0.10', '0.05', '0.20',
            ${JSON.stringify({ energyThresholdKwh: OCTT_THRESHOLD_KWH })}::jsonb, true, 50, false)
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
