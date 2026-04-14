// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

export interface OcpiRoutingHeaders {
  requestId: string;
  correlationId: string;
  fromCountryCode?: string;
  fromPartyId?: string;
  toCountryCode?: string;
  toPartyId?: string;
}

export function parseRoutingHeaders(request: FastifyRequest): OcpiRoutingHeaders {
  const headers = request.headers;
  const result: OcpiRoutingHeaders = {
    requestId: (headers['x-request-id'] as string | undefined) ?? randomUUID(),
    correlationId: (headers['x-correlation-id'] as string | undefined) ?? randomUUID(),
  };
  const fromCountry = headers['ocpi-from-country-code'] as string | undefined;
  const fromParty = headers['ocpi-from-party-id'] as string | undefined;
  const toCountry = headers['ocpi-to-country-code'] as string | undefined;
  const toParty = headers['ocpi-to-party-id'] as string | undefined;
  if (fromCountry != null) result.fromCountryCode = fromCountry;
  if (fromParty != null) result.fromPartyId = fromParty;
  if (toCountry != null) result.toCountryCode = toCountry;
  if (toParty != null) result.toPartyId = toParty;
  return result;
}

export function buildRoutingHeaders(
  fromCountryCode: string,
  fromPartyId: string,
  toCountryCode: string,
  toPartyId: string,
  correlationId?: string,
): Record<string, string> {
  return {
    'X-Request-ID': randomUUID(),
    'X-Correlation-ID': correlationId ?? randomUUID(),
    'OCPI-from-country-code': fromCountryCode,
    'OCPI-from-party-id': fromPartyId,
    'OCPI-to-country-code': toCountryCode,
    'OCPI-to-party-id': toPartyId,
  };
}
