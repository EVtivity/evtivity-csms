// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createLogger } from '@evtivity/lib';
import { buildRoutingHeaders } from './ocpi-headers.js';
import type { OcpiResponseEnvelope } from './ocpi-response.js';

const logger = createLogger('ocpi-client');

// Hard cap on outbound OCPI HTTP calls. Without a timeout, fetch() inherits
// the platform default which on Node is effectively forever - one slow or
// unresponsive partner endpoint would pin a Fastify worker indefinitely and
// cascade into pool exhaustion across pull/push/credentials flows.
const REQUEST_TIMEOUT_MS = 30_000;

// Outbound SSRF guard for OCPI calls. Partner URLs are operator-registered, but
// a misconfigured or hostile endpoint must never reach the host's own network.
// Enforce http(s); resolve the hostname and reject if ANY resolved address is
// link-local (169.254.0.0/16, incl. cloud metadata; fe80::/10) or 0.0.0.0/8;
// follow redirects manually so every hop is re-checked. Loopback and private
// ranges stay allowed - private B2B peering and the local test simulators use
// them. Residual: fetch re-resolves DNS on connect, so a sub-second rebind
// between check and connect is not fully closed (that needs a pinning dispatcher).
const MAX_OUTBOUND_REDIRECTS = 5;

function isIpv4Blocked(ip: string): boolean {
  const octets = ip.split('.').map((p) => Number(p));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 0 || (a === 169 && b === 254); // 0.0.0.0/8, 169.254.0.0/16
}

function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isIpv4Blocked(ip);
  if (fam === 6) {
    const low = ip.toLowerCase();
    const mapped = low.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)?.[1];
    if (mapped != null) return isIpv4Blocked(mapped); // IPv4-mapped IPv6
    return /^fe[89ab][0-9a-f]:/.test(low); // fe80::/10 link-local
  }
  return false;
}

async function assertSafeOutboundUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid OCPI target URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTP OCPI target protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    const resolved = await dnsLookup(host, { all: true }).catch(() => {
      throw new Error(`Could not resolve OCPI target host: ${host}`);
    });
    addresses = resolved.map((r) => r.address);
  }
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new Error(`Blocked link-local/metadata OCPI target: ${host} -> ${addr}`);
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_OUTBOUND_REDIRECTS; hop++) {
      await assertSafeOutboundUrl(target);
      const res = await fetch(target, { ...init, signal: controller.signal, redirect: 'manual' });
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get('location');
      if (location == null || location === '') return res;
      target = new URL(location, target).toString();
    }
    throw new Error(`Too many redirects for OCPI target: ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface OcpiClientOptions {
  token: string;
  fromCountryCode: string;
  fromPartyId: string;
  toCountryCode: string;
  toPartyId: string;
}

export class OcpiClient {
  private readonly token: string;
  private readonly fromCountryCode: string;
  private readonly fromPartyId: string;
  private readonly toCountryCode: string;
  private readonly toPartyId: string;

  constructor(options: OcpiClientOptions) {
    this.token = options.token;
    this.fromCountryCode = options.fromCountryCode;
    this.fromPartyId = options.fromPartyId;
    this.toCountryCode = options.toCountryCode;
    this.toPartyId = options.toPartyId;
  }

  private buildHeaders(correlationId?: string): Record<string, string> {
    const tokenBase64 = Buffer.from(this.token).toString('base64');
    return {
      Authorization: `Token ${tokenBase64}`,
      'Content-Type': 'application/json',
      ...buildRoutingHeaders(
        this.fromCountryCode,
        this.fromPartyId,
        this.toCountryCode,
        this.toPartyId,
        correlationId,
      ),
    };
  }

  async get<T>(url: string, correlationId?: string): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI GET');
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: this.buildHeaders(correlationId),
    });
    return this.parseResponse<T>(response, url);
  }

  async post<T>(
    url: string,
    body: unknown,
    correlationId?: string,
  ): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI POST');
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: this.buildHeaders(correlationId),
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response, url);
  }

  async put<T>(
    url: string,
    body: unknown,
    correlationId?: string,
  ): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI PUT');
    const response = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: this.buildHeaders(correlationId),
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response, url);
  }

  async patch<T>(
    url: string,
    body: unknown,
    correlationId?: string,
  ): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI PATCH');
    const response = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: this.buildHeaders(correlationId),
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response, url);
  }

  async delete<T>(url: string, correlationId?: string): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI DELETE');
    const response = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: this.buildHeaders(correlationId),
    });
    return this.parseResponse<T>(response, url);
  }

  private async parseResponse<T>(
    response: Response,
    url: string,
  ): Promise<OcpiResponseEnvelope<T>> {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as OcpiResponseEnvelope<T>;
      if (!response.ok) {
        logger.warn(
          { url, status: response.status, ocpiStatus: parsed.status_code },
          'OCPI request failed',
        );
      }
      return parsed;
    } catch {
      logger.error(
        { url, status: response.status, body: text.slice(0, 500) },
        'Failed to parse OCPI response',
      );
      throw new Error(`Failed to parse OCPI response from ${url}: ${String(response.status)}`);
    }
  }

  async getPaginated<T>(url: string, correlationId?: string): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = url;
    // A misbehaving partner endpoint that echoes the same pagination URL in
    // rel="next" would otherwise spin forever and exhaust memory; the
    // visited set caps each pull at one trip through each unique URL.
    // The hard page cap is the second line of defense for the case where
    // a partner is paginating correctly but the dataset is unreasonably
    // large (e.g., a buggy partner exporting a tariff per location).
    const visited = new Set<string>();
    const MAX_PAGES = 1000;
    let pageCount = 0;

    while (nextUrl != null) {
      if (visited.has(nextUrl)) {
        break;
      }
      if (pageCount >= MAX_PAGES) {
        break;
      }
      visited.add(nextUrl);
      pageCount++;

      const response = await fetchWithTimeout(nextUrl, {
        method: 'GET',
        headers: this.buildHeaders(correlationId),
      });

      const text = await response.text();
      const parsed = JSON.parse(text) as OcpiResponseEnvelope<T[]>;

      if (Array.isArray(parsed.data)) {
        results.push(...parsed.data);
      }

      const linkHeader = response.headers.get('Link');
      nextUrl = parseLinkHeader(linkHeader);
    }

    return results;
  }
}

function parseLinkHeader(linkHeader: string | null): string | null {
  if (linkHeader == null) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}
