// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger, safeFetch } from '@evtivity/lib';
import type { SafeFetchInit, SafeFetchResponse } from '@evtivity/lib';
import { buildRoutingHeaders } from './ocpi-headers.js';
import type { OcpiResponseEnvelope } from './ocpi-response.js';

const logger = createLogger('ocpi-client');

// Hard cap on outbound OCPI HTTP calls. Without a timeout, fetch() inherits
// the platform default which on Node is effectively forever - one slow or
// unresponsive partner endpoint would pin a Fastify worker indefinitely and
// cascade into pool exhaustion across pull/push/credentials flows.
const REQUEST_TIMEOUT_MS = 30_000;

// Outbound SSRF guard: every request goes through safeFetch, which resolves
// the host and checks each address at connect time (no rebinding window). A
// partner without the operator's "private network" flag
// (ocpi_partners.allow_private_network) reaches public addresses only; a
// partner with it may use loopback and private addresses (private peering,
// local simulators), never unroutable ones such as the cloud metadata
// address. Redirects are followed manually so each hop keeps its method and
// body, and each hop's connection is checked the same way.
const MAX_OUTBOUND_REDIRECTS = 5;

type OcpiRequestInit = Omit<SafeFetchInit, 'signal' | 'redirect' | 'allowPrivateNetworks'>;

async function fetchWithTimeout(
  url: string,
  init: OcpiRequestInit,
  allowPrivateNetwork: boolean,
): Promise<SafeFetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_OUTBOUND_REDIRECTS; hop++) {
      const res = await safeFetch(target, {
        ...init,
        signal: controller.signal,
        redirect: 'manual',
        allowPrivateNetworks: allowPrivateNetwork,
      });
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get('location');
      if (location == null || location === '') return res;
      await res.body?.cancel();
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
  /** The partner's ocpi_partners.allow_private_network flag. */
  allowPrivateNetwork: boolean;
}

export class OcpiClient {
  private readonly token: string;
  private readonly fromCountryCode: string;
  private readonly fromPartyId: string;
  private readonly toCountryCode: string;
  private readonly toPartyId: string;
  private readonly allowPrivateNetwork: boolean;

  constructor(options: OcpiClientOptions) {
    this.token = options.token;
    this.fromCountryCode = options.fromCountryCode;
    this.fromPartyId = options.fromPartyId;
    this.toCountryCode = options.toCountryCode;
    this.toPartyId = options.toPartyId;
    this.allowPrivateNetwork = options.allowPrivateNetwork;
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
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: this.buildHeaders(correlationId),
      },
      this.allowPrivateNetwork,
    );
    return this.parseResponse<T>(response, url);
  }

  async post<T>(
    url: string,
    body: unknown,
    correlationId?: string,
  ): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI POST');
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: this.buildHeaders(correlationId),
        body: JSON.stringify(body),
      },
      this.allowPrivateNetwork,
    );
    return this.parseResponse<T>(response, url);
  }

  async put<T>(
    url: string,
    body: unknown,
    correlationId?: string,
  ): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI PUT');
    const response = await fetchWithTimeout(
      url,
      {
        method: 'PUT',
        headers: this.buildHeaders(correlationId),
        body: JSON.stringify(body),
      },
      this.allowPrivateNetwork,
    );
    return this.parseResponse<T>(response, url);
  }

  async patch<T>(
    url: string,
    body: unknown,
    correlationId?: string,
  ): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI PATCH');
    const response = await fetchWithTimeout(
      url,
      {
        method: 'PATCH',
        headers: this.buildHeaders(correlationId),
        body: JSON.stringify(body),
      },
      this.allowPrivateNetwork,
    );
    return this.parseResponse<T>(response, url);
  }

  async delete<T>(url: string, correlationId?: string): Promise<OcpiResponseEnvelope<T>> {
    logger.debug({ url }, 'OCPI DELETE');
    const response = await fetchWithTimeout(
      url,
      {
        method: 'DELETE',
        headers: this.buildHeaders(correlationId),
      },
      this.allowPrivateNetwork,
    );
    return this.parseResponse<T>(response, url);
  }

  private async parseResponse<T>(
    response: SafeFetchResponse,
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

  /**
   * Walk an OCPI paginated collection, handing each page to `onPage` as it
   * arrives instead of buffering the whole dataset. Bounds memory for large
   * partner catalogs: a caller that flushes each page to the DB never holds
   * more than one page at a time.
   */
  async getPaginatedEach(
    url: string,
    onPage: (page: unknown[]) => Promise<void>,
    correlationId?: string,
  ): Promise<void> {
    let nextUrl: string | null = url;
    // A misbehaving partner endpoint that echoes the same pagination URL in
    // rel="next" would otherwise spin forever; the visited set caps each pull
    // at one trip through each unique URL. The hard page cap is the second line
    // of defense for a partner that paginates correctly but returns an
    // unreasonably large dataset.
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

      const response = await fetchWithTimeout(
        nextUrl,
        {
          method: 'GET',
          headers: this.buildHeaders(correlationId),
        },
        this.allowPrivateNetwork,
      );

      const text = await response.text();
      const parsed = JSON.parse(text) as OcpiResponseEnvelope<unknown[]>;

      if (Array.isArray(parsed.data) && parsed.data.length > 0) {
        await onPage(parsed.data);
      }

      const linkHeader = response.headers.get('Link');
      nextUrl = parseLinkHeader(linkHeader);
    }
  }

  async getPaginated<T>(url: string, correlationId?: string): Promise<T[]> {
    const results: T[] = [];
    await this.getPaginatedEach(
      url,
      (page) => {
        results.push(...(page as T[]));
        return Promise.resolve();
      },
      correlationId,
    );
    return results;
  }
}

function parseLinkHeader(linkHeader: string | null): string | null {
  if (linkHeader == null) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}
