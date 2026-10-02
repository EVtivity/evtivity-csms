// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppClient } from '@evtivity/css/ocpp-client';
import type { Logger } from 'pino';
import type { OcspTestService } from './ocsp-test-service.js';
import type { NotApplicable } from './pics/types.js';

export type OcppVersion = 'ocpp1.6' | 'ocpp2.1';
export type SutType = 'csms' | 'cs';
export type TestStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface TestCase {
  id: string;
  name: string;
  module: string;
  version: OcppVersion;
  sut: SutType;
  description: string;
  purpose: string;
  /** Override the onboarding status used when provisioning the test station (default: 'accepted') */
  onboardingStatus?: 'accepted' | 'pending' | 'blocked' | undefined;
  /** Provision the test station with this security profile and Basic Auth password (default: profile 0). */
  provision?: { securityProfile: number; password?: string | undefined } | undefined;
  execute: (ctx: TestContext) => Promise<TestResult>;
}

export type TriggerCommandFn = (
  version: 'v21' | 'v16',
  action: string,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Calls the CSMS REST API (path under /v1) with the runner's API key. */
export type CallApiFn = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * idTokens provisioned for one test (unique per test, at most 20 characters so
 * they also fit the 1.6 idTag CiString20). Per OCTT test procedure 8.2 every
 * test starts without a running transaction, so tests never share a token.
 */
export interface TestTokens {
  /** Active token: Authorize returns Accepted. */
  valid: string;
  /** A second active token, for tests that need a different driver token. */
  valid2: string;
  /** Active token used as the MasterPass token (TC_C_47/48/49). */
  masterpass: string;
  /** Inactive token: Authorize returns Blocked. */
  blocked: string;
  /** Active token whose expiry date has passed: Authorize returns Expired. */
  expired: string;
  /** Active prepaid token with credit: Authorize returns Accepted (TC_C_103). */
  prepaid: string;
  /** Prepaid token with a zero balance: Authorize returns NoCredit (TC_C_104). */
  noCredit: string;
  /** Active eMAID token (type eMAID) for contract certificate tests (TC_C_50). */
  emaid: string;
}

export interface TestContext {
  client: OcppClient;
  stationId: string;
  /** idTokens provisioned for this test. */
  tokens: TestTokens;
  /** charging_stations.id of the provisioned test station. */
  stationDbId: string | null;
  logger: Logger;
  config: RunConfig;
  triggerCommand?: TriggerCommandFn | undefined;
  callApi?: CallApiFn | undefined;
  /** Test System PKI and OCSP responder, present when the run has `ocspResponderUrl`. */
  ocsp?: OcspTestService | undefined;
}

export interface TestResult {
  status: TestStatus;
  durationMs: number;
  steps: StepResult[];
  error?: string | undefined;
}

export interface StepResult {
  step: number;
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  expected?: string | undefined;
  actual?: string | undefined;
}

export interface RunConfig {
  serverUrl: string;
  version?: OcppVersion | undefined;
  sut?: SutType | undefined;
  module?: string | undefined;
  testIds?: string[] | undefined;
  concurrency?: number | undefined;
  password?: string | undefined;
  logLevel?: string | undefined;
  provisionStations?: boolean | undefined;
  apiUrl?: string | undefined;
  /** wss:// address of the CSMS TLS endpoint, for tests that reconnect with security profile 2. */
  tlsServerUrl?: string | undefined;
  /** PEM of the CA that issued the CSMS TLS certificate; the test station trusts it on wss:// connections. */
  tlsCaCert?: string | undefined;
  /**
   * URL at which the CSMS reaches the runner's OCSP responder (the Test System
   * OCSP service). The runner listens on its port on all interfaces. Without
   * it, steps that need the responder are skipped.
   */
  ocspResponderUrl?: string | undefined;
}

export interface RunSummary {
  /** Every selected test, including the ones the PICS makes not applicable. */
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  /** Tests the Device Under Test's PICS excludes. They are never executed. */
  notApplicable: number;
  durationMs: number;
}

/**
 * Status the runners report. `notApplicable` means the Device Under Test's
 * PICS excludes the test, so the runner does not execute it (real OCTT
 * pre-filters by PICS). Distinct from `skipped`, which means an applicable
 * test that could not run. A test's own `execute` never returns it.
 */
export type ReportedTestStatus = TestStatus | 'notApplicable';

export interface ReportedTestResult extends Omit<TestResult, 'status'> {
  status: ReportedTestStatus;
  /** Set when status is `notApplicable`: the PICS item that excludes the test, and why. */
  notApplicable?: NotApplicable | undefined;
}

export interface TestCaseResult {
  testId: string;
  testName: string;
  module: string;
  version: OcppVersion;
  result: ReportedTestResult;
}
