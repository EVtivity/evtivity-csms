// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { OcppClient } from '@evtivity/css/ocpp-client';
import type { OcppVersion } from './types.js';

export interface TestClientOptions {
  serverUrl: string;
  stationId: string;
  version: OcppVersion;
  password?: string | undefined;
  securityProfile?: number | undefined;
}

export function createTestClient(options: TestClientOptions): OcppClient {
  return new OcppClient({
    serverUrl: options.serverUrl,
    stationId: options.stationId,
    ocppProtocol: options.version,
    password: options.password,
    securityProfile: options.securityProfile,
  });
}

export function generateStationId(module: string, testId: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `OCTT-${module}-${testId}-${suffix}`;
}
