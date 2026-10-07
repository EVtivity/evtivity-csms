// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { ocpiSuccess } from '../lib/ocpi-response.js';
import { config } from '../lib/config.js';
import { ocpiAuthenticateRegistration } from '../middleware/ocpi-auth.js';
import { OCPI_MODULES } from '../modules.js';
import type {
  OcpiVersion,
  OcpiVersionInfo,
  OcpiVersionDetail,
  OcpiEndpoint,
} from '../types/ocpi.js';

const SUPPORTED_VERSIONS: OcpiVersion[] = ['2.2.1', '2.3.0'];

function getBaseUrl(): string {
  return config.OCPI_BASE_URL;
}

function buildVersionList(): OcpiVersionInfo[] {
  const baseUrl = getBaseUrl();
  return SUPPORTED_VERSIONS.map((version) => ({
    version,
    url: `${baseUrl}/ocpi/${version}`,
  }));
}

export function buildModuleEndpoints(version: OcpiVersion): OcpiEndpoint[] {
  const baseUrl = getBaseUrl();
  const prefix = `${baseUrl}/ocpi/${version}`;

  return [
    // The credentials handshake is not a registry module.
    { identifier: 'credentials', role: 'SENDER', url: `${prefix}/credentials` },
    { identifier: 'credentials', role: 'RECEIVER', url: `${prefix}/credentials` },
    ...OCPI_MODULES.flatMap((m) =>
      m.endpoints.map((e) => ({
        identifier: m.identifier,
        role: e.role,
        url: `${prefix}/${e.path}`,
      })),
    ),
  ];
}

export function versionRoutes(app: FastifyInstance): void {
  // GET /ocpi/versions - no auth required, returns list of supported versions
  app.get('/ocpi/versions', () => {
    return ocpiSuccess(buildVersionList());
  });

  // GET /ocpi/2.2.1 - accepts registration tokens (needed during credentials handshake)
  app.get('/ocpi/2.2.1', { onRequest: [ocpiAuthenticateRegistration] }, () => {
    const detail: OcpiVersionDetail = {
      version: '2.2.1',
      endpoints: buildModuleEndpoints('2.2.1'),
    };
    return ocpiSuccess(detail);
  });

  // GET /ocpi/2.3.0 - accepts registration tokens (needed during credentials handshake)
  app.get('/ocpi/2.3.0', { onRequest: [ocpiAuthenticateRegistration] }, () => {
    const detail: OcpiVersionDetail = {
      version: '2.3.0',
      endpoints: buildModuleEndpoints('2.3.0'),
    };
    return ocpiSuccess(detail);
  });
}
