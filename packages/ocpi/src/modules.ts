// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { OcpiInterfaceRole, OcpiModuleId } from './types/ocpi.js';
import type { SyncResult } from './services/pull.service.js';
import { pullCdrs, pullLocations, pullTariffs } from './services/pull.service.js';
import { cpoLocationRoutes } from './routes/cpo/locations.js';
import { cpoSessionRoutes, cpoCdrRoutes } from './routes/cpo/sessions.js';
import { cpoTariffRoutes } from './routes/cpo/tariffs.js';
import { cpoTokenRoutes } from './routes/cpo/tokens.js';
import { cpoCommandRoutes } from './routes/cpo/commands.js';
import { emspLocationRoutes } from './routes/emsp/locations.js';
import { emspSessionRoutes } from './routes/emsp/sessions.js';
import { emspCdrRoutes } from './routes/emsp/cdrs.js';
import { emspTariffRoutes } from './routes/emsp/tariffs.js';
import { emspTokenRoutes } from './routes/emsp/tokens.js';
import { emspCommandRoutes } from './routes/emsp/commands.js';
import { hubClientInfoRoutes } from './routes/hubclientinfo.js';

export interface OcpiModuleEndpoint {
  role: OcpiInterfaceRole;
  // Path under /ocpi/{version}/, as listed in the version details endpoint list.
  path: string;
}

export interface OcpiModule {
  identifier: Exclude<OcpiModuleId, 'credentials'>;
  // Endpoints advertised in GET /ocpi/{version}, in order.
  endpoints: readonly OcpiModuleEndpoint[];
  routes: readonly ((app: FastifyInstance) => void)[];
  // Pulls the module from a partner's SENDER endpoint on an `ocpi_sync` request.
  // The modules with a pull must equal OCPI_PULL_MODULES in @evtivity/lib.
  pull?: (partnerId: string, lockRedis?: Redis) => Promise<SyncResult>;
}

// The built-in OCPI modules. The credentials and versions handshake routes are
// not modules: app.ts and routes/versions.ts register and list them directly.
export const OCPI_MODULES: readonly OcpiModule[] = [
  {
    identifier: 'locations',
    endpoints: [
      { role: 'SENDER', path: 'cpo/locations' },
      { role: 'RECEIVER', path: 'emsp/locations' },
    ],
    routes: [cpoLocationRoutes, emspLocationRoutes],
    pull: pullLocations,
  },
  {
    identifier: 'sessions',
    endpoints: [
      { role: 'SENDER', path: 'cpo/sessions' },
      { role: 'RECEIVER', path: 'emsp/sessions' },
    ],
    routes: [cpoSessionRoutes, emspSessionRoutes],
  },
  {
    identifier: 'cdrs',
    endpoints: [
      { role: 'SENDER', path: 'cpo/cdrs' },
      { role: 'RECEIVER', path: 'emsp/cdrs' },
    ],
    routes: [cpoCdrRoutes, emspCdrRoutes],
    pull: pullCdrs,
  },
  {
    identifier: 'tariffs',
    endpoints: [
      { role: 'SENDER', path: 'cpo/tariffs' },
      { role: 'RECEIVER', path: 'emsp/tariffs' },
    ],
    routes: [cpoTariffRoutes, emspTariffRoutes],
    pull: pullTariffs,
  },
  {
    identifier: 'tokens',
    endpoints: [
      { role: 'SENDER', path: 'emsp/tokens' },
      { role: 'RECEIVER', path: 'cpo/tokens' },
    ],
    routes: [cpoTokenRoutes, emspTokenRoutes],
  },
  {
    identifier: 'commands',
    // Only the CPO receiver is advertised; the eMSP routes take command result callbacks.
    endpoints: [{ role: 'RECEIVER', path: 'cpo/commands' }],
    routes: [cpoCommandRoutes, emspCommandRoutes],
  },
  {
    identifier: 'hubclientinfo',
    endpoints: [{ role: 'RECEIVER', path: 'hubclientinfo' }],
    routes: [hubClientInfoRoutes],
  },
];
