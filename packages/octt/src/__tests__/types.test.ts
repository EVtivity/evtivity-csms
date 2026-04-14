// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import type { TestCase, StepResult, RunConfig, RunSummary } from '../types.js';

describe('types', () => {
  it('TestCase satisfies the interface', () => {
    const tc: TestCase = {
      id: 'TC_B_01_CSMS',
      name: 'Boot Notification - Cold Boot',
      module: 'B-provisioning',
      version: 'ocpp2.1',
      sut: 'csms',
      description: 'Test BootNotification cold boot',
      purpose: 'Verify CSMS accepts BootNotification',
      execute: async () => ({
        status: 'passed',
        durationMs: 100,
        steps: [],
      }),
    };
    expect(tc.id).toBe('TC_B_01_CSMS');
    expect(tc.version).toBe('ocpp2.1');
    expect(tc.sut).toBe('csms');
  });

  it('RunConfig filters work', () => {
    const config: RunConfig = {
      serverUrl: 'ws://localhost:3003',
      version: 'ocpp2.1',
      sut: 'csms',
      module: 'B-provisioning',
      concurrency: 5,
    };
    expect(config.concurrency).toBe(5);
  });

  it('RunSummary aggregates counts', () => {
    const summary: RunSummary = {
      total: 10,
      passed: 7,
      failed: 2,
      skipped: 1,
      errors: 0,
      durationMs: 5000,
    };
    expect(summary.total).toBe(summary.passed + summary.failed + summary.skipped + summary.errors);
  });

  it('StepResult captures expected vs actual', () => {
    const step: StepResult = {
      step: 1,
      description: 'Send BootNotification',
      status: 'passed',
      expected: 'Accepted',
      actual: 'Accepted',
    };
    expect(step.status).toBe('passed');
  });
});
