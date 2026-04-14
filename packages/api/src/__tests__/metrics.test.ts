// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prom-client
const mockRegister = {
  metrics: vi.fn().mockResolvedValue('# HELP test_metric\ntest_metric 1\n'),
  contentType: 'text/plain; version=0.0.4; charset=utf-8',
};

const mockHistogramObserve = vi.fn();
const mockCounterInc = vi.fn();
const mockGaugeSet = vi.fn();
const mockGaugeInc = vi.fn();
const mockGaugeDec = vi.fn();
const mockGaugeReset = vi.fn();

vi.mock('prom-client', () => {
  function MockRegistry(this: Record<string, unknown>) {
    this.metrics = mockRegister.metrics;
    this.contentType = mockRegister.contentType;
  }

  function MockHistogram() {
    return { observe: mockHistogramObserve };
  }

  function MockCounter() {
    return { inc: mockCounterInc };
  }

  function MockGauge() {
    return {
      set: mockGaugeSet,
      inc: mockGaugeInc,
      dec: mockGaugeDec,
      reset: mockGaugeReset,
    };
  }

  return {
    Registry: MockRegistry,
    collectDefaultMetrics: vi.fn(),
    Histogram: MockHistogram,
    Counter: MockCounter,
    Gauge: MockGauge,
  };
});

vi.mock('@evtivity/lib', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('Metrics plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports register and metric instances', async () => {
    const metrics = await import('../plugins/metrics.js');
    expect(metrics.register).toBeDefined();
    expect(metrics.httpRequestDuration).toBeDefined();
    expect(metrics.httpRequestsTotal).toBeDefined();
    expect(metrics.httpActiveRequests).toBeDefined();
    expect(metrics.driversTotal).toBeDefined();
    expect(metrics.sessionsActive).toBeDefined();
  });

  it('startMetricsServer creates an HTTP server', async () => {
    const { startMetricsServer, stopMetricsServer } = await import('../plugins/metrics.js');
    // Just verify it does not throw
    startMetricsServer(0); // port 0 = random
    await stopMetricsServer();
  });
});
