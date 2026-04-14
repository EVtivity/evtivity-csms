// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppTestServer } from './cs-server.js';
import type { OcppVersion, TestResult, RunConfig, StepResult } from './types.js';
import type { Logger } from 'pino';
import type { OcppClient } from '@evtivity/css/ocpp-client';
import type { StationSimulator } from '@evtivity/css/station-simulator';

export interface CsTestCase {
  id: string;
  name: string;
  module: string;
  version: OcppVersion;
  sut: 'cs';
  description: string;
  purpose: string;
  stationConfig?: Partial<CsStationConfig> | undefined;
  /** When true, the executor creates the station and server but does not call
   *  station.start(). The test controls the boot sequence via ctx.station.start().
   *  Use for tests that need to control the BootNotification response (Pending, Rejected). */
  skipAutoBoot?: boolean | undefined;
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
  logger: Logger;
  config: RunConfig;
}

export interface CsStationConfig {
  ocppProtocol: OcppVersion;
  securityProfile: number;
  vendorName: string;
  model: string;
  serialNumber: string;
  evseCount: number;
  connectorsPerEvse: number;
}

export interface CsTestCaseResult {
  testId: string;
  testName: string;
  module: string;
  version: OcppVersion;
  result: TestResult;
}

export { type StepResult };
