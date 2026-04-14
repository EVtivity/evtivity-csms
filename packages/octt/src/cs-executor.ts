// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from 'pino';
import postgres from 'postgres';
import { StationSimulator, type StationConfig } from '@evtivity/css/station-simulator';
import type { RunConfig } from './types.js';
import type { CsTestCase, CsTestCaseResult } from './cs-types.js';
import { OcppTestServer } from './cs-server.js';

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
    sharedSql = postgres(url);
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

  const log = logger.child({ testId: testCase.id, stationId });
  const start = Date.now();

  let station: StationSimulator | null = null;

  try {
    // Start the mini CSMS
    const { port, url } = await server.start();
    log.debug({ port }, 'Test server started');

    // Set default message handler (tests can override via server.setMessageHandler)
    server.setMessageHandler(createDefaultMessageHandler(testCase.version));

    // Create a StationSimulator that connects to the test server.
    // Provision css_stations and css_evses rows so the simulator can track state in DB.
    const sql = getSql();
    const stationConfig = testCase.stationConfig ?? {};
    const dbId = `octt-cs-${stationId}`;
    const simulatorConfig: StationConfig = {
      id: dbId,
      stationId,
      ocppProtocol: stationConfig.ocppProtocol ?? testCase.version,
      securityProfile: stationConfig.securityProfile ?? 0,
      targetUrl: url,
      vendorName: stationConfig.vendorName ?? 'OCTT',
      model: stationConfig.model ?? 'OCTT-Virtual',
      serialNumber: stationConfig.serialNumber ?? 'OCTT-SN-001',
      firmwareVersion: '1.0.0',
      evses: [
        {
          evseId: 1,
          connectorId: 1,
          connectorType: 'ac_type2',
          maxPowerW: 22000,
          phases: 3,
          voltage: 230,
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
      });
    }

    // Provision css_stations row so StationSimulator can persist state
    await sql`
      INSERT INTO css_stations (id, station_id, target_url, ocpp_protocol, security_profile, vendor_name, model, serial_number, firmware_version, status, source_type)
      VALUES (${dbId}, ${stationId}, ${url}, ${simulatorConfig.ocppProtocol}, ${simulatorConfig.securityProfile}, ${simulatorConfig.vendorName}, ${simulatorConfig.model}, ${simulatorConfig.serialNumber}, ${simulatorConfig.firmwareVersion}, 'disconnected', 'api')
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

    const TEST_TIMEOUT_MS = 120_000;
    const result = await Promise.race([
      testCase.execute({
        server,
        station,
        client: station.client,
        stationId,
        logger: log,
        config,
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
  }
}
