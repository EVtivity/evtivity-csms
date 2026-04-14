// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyServerOptions } from 'fastify';
import { RedisPubSubClient, initSentry } from '@evtivity/lib';
import { getSentryConfig } from '@evtivity/database';
import { buildApp } from './app.js';
import { config } from './lib/config.js';
import { setPubSub } from './lib/pubsub.js';
import { setReportLogger, registerGenerator } from './services/report.service.js';
import { generateNeviReport } from './services/report-generators/nevi-report.js';
import { generateRevenueReport } from './services/report-generators/revenue-report.js';
import { generateEnergyReport } from './services/report-generators/energy-report.js';
import { generateSessionsReport } from './services/report-generators/sessions-report.js';
import { generateUtilizationReport } from './services/report-generators/utilization-report.js';
import { generateStationHealthReport } from './services/report-generators/station-health-report.js';
import { generateSustainabilityReport } from './services/report-generators/sustainability-report.js';
import { generateDriverActivityReport } from './services/report-generators/driver-activity-report.js';
import { startMetricsServer, stopMetricsServer, registerHttpMetrics } from './plugins/metrics.js';
import {
  startMetricsCollector,
  stopMetricsCollector,
} from './services/metrics-collector.service.js';

async function start(): Promise<void> {
  const sentryConfig = await getSentryConfig();
  initSentry('evtivity-api', sentryConfig);

  const opts: FastifyServerOptions = {
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url.replace(/token=[^&]+/, 'token=REDACTED'),
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
  };

  if (config.NODE_ENV !== 'production') {
    (opts.logger as Record<string, unknown>)['transport'] = {
      target: 'pino-pretty',
    };
  }

  const app = await buildApp(opts);

  registerHttpMetrics(app);
  startMetricsServer(config.METRICS_PORT);
  startMetricsCollector();

  const pubsub = new RedisPubSubClient(config.REDIS_URL);
  setPubSub(pubsub);

  app.addHook('onClose', async () => {
    stopMetricsCollector();
    await stopMetricsServer();
    await pubsub.close();
  });

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  app.log.info(`API server listening on ${config.API_HOST}:${String(config.API_PORT)}`);

  setReportLogger(app.log);
  registerGenerator('nevi', generateNeviReport);
  registerGenerator('revenue', generateRevenueReport);
  registerGenerator('energy', generateEnergyReport);
  registerGenerator('sessions', generateSessionsReport);
  registerGenerator('utilization', generateUtilizationReport);
  registerGenerator('stationHealth', generateStationHealthReport);
  registerGenerator('sustainability', generateSustainabilityReport);
  registerGenerator('driverActivity', generateDriverActivityReport);
}

start().catch((err: unknown) => {
  console.error('Failed to start API server:', err);
  process.exit(1);
});
