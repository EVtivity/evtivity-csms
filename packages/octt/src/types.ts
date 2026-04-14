// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppClient } from '@evtivity/css/ocpp-client';
import type { Logger } from 'pino';

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
  execute: (ctx: TestContext) => Promise<TestResult>;
}

export type TriggerCommandFn = (
  version: 'v21' | 'v16',
  action: string,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface TestContext {
  client: OcppClient;
  stationId: string;
  logger: Logger;
  config: RunConfig;
  triggerCommand?: TriggerCommandFn | undefined;
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
}

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface TestCaseResult {
  testId: string;
  testName: string;
  module: string;
  version: OcppVersion;
  result: TestResult;
}
