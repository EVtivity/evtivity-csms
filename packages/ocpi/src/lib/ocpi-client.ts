// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from '@evtivity/lib';
import { buildRoutingHeaders } from './ocpi-headers.js';
import type { OcpiResponseEnvelope } from './ocpi-response.js';

const logger = createLogger('ocpi-client');

// Hard cap on outbound OCPI HTTP calls. Without a timeout, fetch() inherits
// the platform default which on Node is effectively forever - one slow or
// unresponsive partner endpoint would pin a Fastify worker indefinitely and
// cascade into pool exhaustion across pull/push/credentials flows.
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
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

    while (nextUrl != null) {
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
