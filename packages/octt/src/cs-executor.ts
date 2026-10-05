// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import postgres from 'postgres';
import { connectionName } from '@evtivity/lib';
import { StationSimulator, type StationConfig } from '@evtivity/css/station-simulator';
import type { RunConfig } from './types.js';
import type { CsTestCase, CsTestCaseResult, CsTlsMaterial } from './cs-types.js';
import { OcppTestServer, type TestServerTls } from './cs-server.js';
import { createRootCertificate, issueCertificate } from './cs-security-pki.js';
import { newTestPassword } from './security-test-helpers.js';

/** wss:// settings of a test server for a security profile, or undefined for ws://. */
function serverTlsFor(
  securityProfile: number,
  tls: CsTlsMaterial | undefined,
): TestServerTls | undefined {
  if (tls == null || securityProfile < 2) return undefined;
  return {
    cert: `${tls.server.pem}\n${tls.root.pem}`,
    key: tls.server.keyPem,
    ca: tls.root.pem,
    requestCert: true,
  };
}

// OCPP 2.1 reconnect back-off of a test station (OCPPCommCtrlr.RetryBackOff*): the
// first attempt 10-15 s after a connection loss. The CS test waits and timeouts were
// measured with these values; fleet stations use the faster, wider-spread factory
// defaults (CSS_RETRY_BACK_OFF_DEFAULTS). Ignored by 1.6 stations.
export const CS_TEST_RECONNECT_BACK_OFF: Readonly<Record<string, string>> = {
  'OCPPCommCtrlr.RetryBackOffWaitMinimum': '10',
  'OCPPCommCtrlr.RetryBackOffRandomRange': '5',
  'OCPPCommCtrlr.RetryBackOffRepeatTimes': '3',
};

function generateCsStationId(module: string, testId: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `OCTT-CS-${module}-${testId}-${suffix}`;
}

/** Shared DB connection for all CS tests. StationSimulator uses css_* tables as working memory. */
let sharedSql: ReturnType<typeof postgres> | null = null;

function getSql(): ReturnType<typeof postgres> {
  if (sharedSql == null) {
    const url =
      process.env['DATABASE_URL'] ?? 'postgres://evtivity:evtivity@localhost:5433/evtivity';
    sharedSql = postgres(url, { connection: { application_name: connectionName() } });
  }
  return sharedSql;
}

/** Clean up the shared DB connection. Called by the runner after all tests complete. */
export async function closeCsSql(): Promise<void> {
  if (sharedSql != null) {
    await sharedSql.end();
    sharedSql = null;
  }
}

/**
 * Create a version-aware default message handler for the test server.
 * Returns valid responses for station-initiated messages based on OCPP version.
 */
function createDefaultMessageHandler(
  version: 'ocpp1.6' | 'ocpp2.1',
): (action: string) => Promise<Record<string, unknown>> {
  const handler = (action: string): Record<string, unknown> => {
    if (action === 'BootNotification') {
      return { currentTime: new Date().toISOString(), interval: 300, status: 'Accepted' };
    }
    if (action === 'StatusNotification') return {};
    if (action === 'Heartbeat') return { currentTime: new Date().toISOString() };
    if (action === 'Authorize') {
      return version === 'ocpp1.6'
        ? { idTagInfo: { status: 'Accepted' } }
        : { idTokenInfo: { status: 'Accepted' } };
    }
    if (action === 'TransactionEvent') return {};
    if (action === 'MeterValues') return {};
    if (action === 'NotifyReport') return {};
    if (action === 'NotifyEvent') return {};
    if (action === 'LogStatusNotification') return {};
    if (action === 'FirmwareStatusNotification') return {};
    if (action === 'SecurityEventNotification') return {};
    if (action === 'SignCertificate') return { status: 'Accepted' };
    if (action === 'DataTransfer') return { status: 'Accepted' };
    if (action === 'StartTransaction') {
      return {
        idTagInfo: { status: 'Accepted' },
        transactionId: Math.floor(Math.random() * 100000),
      };
    }
    if (action === 'StopTransaction') return { idTagInfo: { status: 'Accepted' } };
    if (action === 'DiagnosticsStatusNotification') return {};
    return {};
  };
  return (action: string) => Promise.resolve(handler(action));
}

export async function executeCsTest(
  testCase: CsTestCase,
  config: RunConfig,
  logger: Logger,
): Promise<CsTestCaseResult> {
  const stationId = generateCsStationId(testCase.module, testCase.id);
  const server = new OcppTestServer();
  const extraServers: OcppTestServer[] = [];

  const log = logger.child({ testId: testCase.id, stationId });
  const start = Date.now();

  let station: StationSimulator | null = null;

  try {
    const stationConfig = testCase.stationConfig ?? {};
    const serialNumber = stationConfig.serialNumber ?? 'OCTT-SN-001';
    const vendorName = stationConfig.vendorName ?? 'OCTT';

    // Test System PKI for wss:// tests: the station trusts the root, and on
    // security profile 3 authenticates with a client certificate it issued.
    let tls: CsTlsMaterial | undefined;
    if (testCase.tls === true) {
      const root = await createRootCertificate('OCTT Central System Root CA');
      tls = {
        root,
        server: await issueCertificate({
          subject: 'CN=localhost,O=OCTT,C=US',
          issuer: root,
          dnsNames: ['localhost'],
          extendedKeyUsages: ['1.3.6.1.5.5.7.3.1'],
        }),
        chargePoint: await issueCertificate({
          subject: `CN=${serialNumber},O=${vendorName}`,
          issuer: root,
          extendedKeyUsages: ['1.3.6.1.5.5.7.3.2'],
        }),
      };
    }

    const securityProfile = stationConfig.securityProfile ?? (tls != null ? 3 : 0);
    // <Configured basicAuthPassword>: a valid OCPP passwordString (2.1 A00.FR.205).
    const password = newTestPassword();

    // Start the mini CSMS: wss:// for security profile 2 and 3. A lower-profile
    // test with `tls` gets the PKI for a later upgrade (TC_A_19) on ws://.
    const { port, url } = await server.start(serverTlsFor(securityProfile, tls));
    log.debug({ port }, 'Test server started');

    // Set default message handler (tests can override via server.setMessageHandler)
    server.setMessageHandler(createDefaultMessageHandler(testCase.version));

    // Create a StationSimulator that connects to the test server.
    // Provision css_stations and css_evses rows so the simulator can track state in DB.
    const sql = getSql();
    const dbId = `octt-cs-${stationId}`;
    const simulatorConfig: StationConfig = {
      id: dbId,
      stationId,
      ocppProtocol: stationConfig.ocppProtocol ?? testCase.version,
      securityProfile,
      targetUrl: url,
      password,
      vendorName,
      model: stationConfig.model ?? 'OCTT-Virtual',
      serialNumber,
      firmwareVersion: '1.0.0',
      // A test station keeps the reconnect back-off the CS test timings were measured
      // with; a test's own overrides win.
      configOverrides: { ...CS_TEST_RECONNECT_BACK_OFF, ...stationConfig.configOverrides },
      // The station verifies the server certificate. On security profile 2 and 3 it
      // has the root installed, and on profile 3 a client certificate the root issued.
      ...(tls != null ? { verifyServerCertificate: true } : {}),
      ...(tls != null && securityProfile >= 2 ? { caCert: tls.root.pem } : {}),
      ...(tls != null && securityProfile === 3
        ? { clientCert: tls.chargePoint.pem, clientKey: tls.chargePoint.keyPem }
        : {}),
      // A test station reconnects without the fleet's reconnect spread.
      reconnectSpreadMs: 0,
      evses: [
        {
          evseId: 1,
          connectorId: 1,
          connectorType: 'ac_type2',
          maxPowerW: 22000,
          phases: 3,
          voltage: 230,
          ...(stationConfig.fixedCable === true ? { fixedCable: true } : {}),
        },
      ],
    };

    // Add additional EVSEs if configured
    const evseCount = stationConfig.evseCount ?? 1;
    for (let i = 2; i <= evseCount; i++) {
      simulatorConfig.evses.push({
        evseId: i,
        connectorId: 1,
        connectorType: 'ac_type2',
        maxPowerW: 22000,
        phases: 3,
        voltage: 230,
        ...(stationConfig.fixedCable === true ? { fixedCable: true } : {}),
      });
    }

    // Provision charging_stations row first to satisfy the css_stations FK.
    // Station identity (vendor, model, serial, firmware, ocppProtocol, securityProfile)
    // lives on charging_stations after the css_stations decouple. The id column
    // has no DB-level default (Drizzle applies $defaultFn at the ORM layer),
    // so raw SQL must supply one. nanoid suffix avoids per-test collisions.
    const chargingStationDbId = 'sta_' + Math.random().toString(36).slice(2, 14);
    await sql`
      INSERT INTO charging_stations (
        id, station_id, model, serial_number, firmware_version,
        ocpp_protocol, security_profile, is_simulator, onboarding_status
      ) VALUES (
        ${chargingStationDbId},
        ${stationId},
        ${simulatorConfig.model},
        ${simulatorConfig.serialNumber},
        ${simulatorConfig.firmwareVersion},
        ${simulatorConfig.ocppProtocol},
        ${simulatorConfig.securityProfile},
        ${true},
        ${'accepted'}
      )
      ON CONFLICT (station_id) DO NOTHING
    `;

    // Provision css_stations row so StationSimulator can persist state. The row
    // is disabled: the fleet simulator manager starts every enabled row, and a
    // second copy of the test station would connect to the test server too.
    await sql`
      INSERT INTO css_stations (id, station_id, target_url, status, source_type, enabled)
      VALUES (${dbId}, ${stationId}, ${url}, 'disconnected', 'api', false)
      ON CONFLICT (id) DO NOTHING
    `;

    // Provision css_evses rows
    for (const evse of simulatorConfig.evses) {
      const evseRowId = `${dbId}-evse-${String(evse.evseId)}`;
      await sql`
        INSERT INTO css_evses (id, css_station_id, evse_id, connector_id, connector_type, max_power_w, phases, voltage, status)
        VALUES (${evseRowId}, ${dbId}, ${evse.evseId}, ${evse.connectorId}, ${evse.connectorType}, ${evse.maxPowerW}, ${evse.phases}, ${evse.voltage}, 'Available')
        ON CONFLICT (id) DO NOTHING
      `;
    }

    station = new StationSimulator(simulatorConfig, sql);

    // Let the station use default reconnect behavior.
    // Tests that involve offline/reconnect scenarios need auto-reconnect.
    // The finally block calls station.stop() which sets destroyed=true to
    // stop reconnect when the test is over.

    // Start the simulator unless the test controls the boot sequence
    if (testCase.skipAutoBoot !== true) {
      await station.start();
      await server.waitForConnection(5000);
      // Clear message buffer so tests don't pick up boot messages
      // (BootNotification, StatusNotification Available, NotifyEvent)
      server.clearBuffer();
      log.debug('Station booted, executing test');
    } else {
      log.debug('Skip auto-boot, test controls boot sequence');
    }

    const TEST_TIMEOUT_MS = testCase.timeoutMs ?? 120_000;
    const result = await Promise.race([
      testCase.execute({
        server,
        station,
        client: station.client,
        stationId,
        logger: log,
        config,
        tls,
        security: { password, serialNumber },
        startServer: async ({ securityProfile: profile }) => {
          const extraTls = serverTlsFor(profile, tls);
          if (profile >= 2 && extraTls == null) {
            throw new Error('A security profile 2/3 server needs a test case with tls');
          }
          const extra = new OcppTestServer();
          extraServers.push(extra);
          const started = await extra.start(extraTls);
          extra.setMessageHandler(createDefaultMessageHandler(testCase.version));
          return { server: extra, url: started.url };
        },
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Test timed out after ${String(TEST_TIMEOUT_MS)}ms`));
        }, TEST_TIMEOUT_MS);
      }),
    ]);

    result.durationMs = Date.now() - start;
    log.debug({ status: result.status, durationMs: result.durationMs }, 'Test completed');

    return {
      testId: testCase.id,
      testName: testCase.name,
      module: testCase.module,
      version: testCase.version,
      result,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ error: errorMessage, durationMs }, 'Test errored');

    return {
      testId: testCase.id,
      testName: testCase.name,
      module: testCase.module,
      version: testCase.version,
      result: {
        status: 'error',
        durationMs,
        steps: [],
        error: errorMessage,
      },
    };
  } finally {
    // Stop simulator (disconnects client) before stopping server
    // to prevent auto-reconnect loops
    if (station != null) {
      await station.stop().catch(() => {});
    }
    await server.stop().catch(() => {});
    for (const extra of extraServers) await extra.stop().catch(() => {});

    // Clean up css_* rows for this test station
    const sql = getSql();
    const dbId = `octt-cs-${stationId}`;
    await sql`DELETE FROM css_config_variables WHERE css_station_id = ${dbId}`.catch(() => {});
    await sql`DELETE FROM css_transactions WHERE css_station_id = ${dbId}`.catch(() => {});
    await sql`DELETE FROM css_charging_profiles WHERE css_station_id = ${dbId}`.catch(() => {});
    await sql`DELETE FROM css_local_auth_entries WHERE css_station_id = ${dbId}`.catch(() => {});
    await sql`DELETE FROM css_installed_certificates WHERE css_station_id = ${dbId}`.catch(
      () => {},
    );
    await sql`DELETE FROM css_display_messages WHERE css_station_id = ${dbId}`.catch(() => {});
    await sql`DELETE FROM css_reservations WHERE css_station_id = ${dbId}`.catch(() => {});
    await sql`DELETE FROM css_evses WHERE css_station_id = ${dbId}`.catch(() => {});
    await sql`DELETE FROM css_stations WHERE id = ${dbId}`.catch(() => {});
    // Delete the paired charging_stations row last. The FK cascade would also remove
    // css_stations, but we already deleted it above for explicitness.
    await sql`DELETE FROM charging_stations WHERE station_id = ${stationId}`.catch(() => {});
  }
}
