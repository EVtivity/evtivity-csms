// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppTestServer } from './cs-server.js';
import type {
  OcppVersion,
  ReportedTestResult,
  TestResult,
  RunConfig,
  StepResult,
} from './types.js';
import type { Logger } from 'pino';
import type { OcppClient } from '@evtivity/css/ocpp-client';
import type { StationSimulator } from '@evtivity/css/station-simulator';
import type { TestCertificate } from './cs-security-pki.js';

/**
 * OCPP versions of the CS test cases. The 2.0.1 cases are the 2.1 cases with
 * the same id, run with the simulator as an OCPP 2.0.1 station (`ocpp201-cs-cases.ts`).
 */
export type CsOcppVersion = OcppVersion;

export interface CsTestCase {
  id: string;
  name: string;
  module: string;
  version: CsOcppVersion;
  sut: 'cs';
  description: string;
  purpose: string;
  stationConfig?: Partial<CsStationConfig> | undefined;
  /** When true, the executor creates the station and server but does not call
   *  station.start(). The test controls the boot sequence via ctx.station.start().
   *  Use for tests that need to control the BootNotification response (Pending, Rejected). */
  skipAutoBoot?: boolean | undefined;
  /** Serve wss:// with a Test System PKI (security profile 2 and 3 tests). The
   *  station trusts the PKI root, verifies the server certificate, and on
   *  security profile 3 presents a client certificate the root issued. */
  tls?: boolean | undefined;
  /** Test timeout in ms (default 120 s). */
  timeoutMs?: number | undefined;
  execute: (ctx: CsTestContext) => Promise<TestResult>;
}

export interface CsTestContext {
  server: OcppTestServer;
  /** The StationSimulator instance acting as the SUT. Use for high-level
   *  station actions: plugIn(), authorize(), startCharging(), stopCharging(),
   *  injectFault(), clearFault(), goOffline(), comeOnline(). */
  station: StationSimulator;
  /** Low-level OcppClient (station.client). Use for sending raw OCPP messages
   *  when the simulator doesn't have a built-in method. */
  client: OcppClient;
  stationId: string;
  /** The OCPP version this run of the case tests (a 2.1 case also runs as 2.0.1). */
  version: CsOcppVersion;
  logger: Logger;
  config: RunConfig;
  /** Test System PKI, set when the test case has `tls`. */
  tls?: CsTlsMaterial | undefined;
  /** The station's configured Basic Auth password and serial number. */
  security: CsTestSecurity;
  /**
   * Start another test server, for example the CSMS of a second network
   * profile slot. Security profile 2 and 3 serve wss:// with the Test System
   * PKI (the test case needs `tls`). The executor stops it after the test.
   */
  startServer(options: {
    securityProfile: number;
  }): Promise<{ server: OcppTestServer; url: string }>;
}

export interface CsTestSecurity {
  /** <Configured basicAuthPassword> the station uses for security profile 1 and 2. */
  password: string;
  /** The station's serial number (CN of its Charging Station certificate). */
  serialNumber: string;
}

export interface CsTlsMaterial {
  /** Central System root CA: the station's trust anchor and the CA that signs CSRs. */
  root: TestCertificate;
  /** Server certificate for localhost, issued by the root. */
  server: TestCertificate;
  /** The station's initial client certificate (security profile 3), issued by the root. */
  chargePoint: TestCertificate;
}

export interface CsStationConfig {
  ocppProtocol: OcppVersion;
  securityProfile: number;
  vendorName: string;
  model: string;
  serialNumber: string;
  evseCount: number;
  connectorsPerEvse: number;
  /** Every connector has a fixed cable (OCTT "Charging Station has a fixed cable"). */
  fixedCable: boolean;
  /** Factory configuration values, applied when the station seeds its defaults
   *  (read-only keys such as SupportedFeatureProfiles or LocalAuthListMaxLength). */
  configOverrides: Record<string, string>;
}

export interface CsTestCaseResult {
  testId: string;
  testName: string;
  module: string;
  version: CsOcppVersion;
  result: ReportedTestResult;
}

export { type StepResult };
