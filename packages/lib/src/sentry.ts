// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as Sentry from '@sentry/node';

let initialized = false;

export interface SentryConfig {
  enabled: boolean;
  dsn: string;
  environment: string;
}

export function initSentry(serviceName: string, config: SentryConfig): void {
  if (initialized) return;

  if (!config.enabled || config.dsn === '') {
    return;
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    serverName: serviceName,
    tracesSampleRate: 0.1,
  });

  initialized = true;
}
