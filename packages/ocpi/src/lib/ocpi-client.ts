// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger, safeFetch } from '@evtivity/lib';
import type { SafeFetchInit, SafeFetchResponse } from '@evtivity/lib';
import { buildRoutingHeaders } from './ocpi-headers.js';
import { OcpiStatusCode } from './ocpi-response.js';
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

/** A partner reply larger than this is refused (no OCPI object or page comes close). */
export const MAX_OCPI_RESPONSE_BYTES = 10 * 1024 * 1024;

type OcpiRequestInit = Omit<SafeFetchInit, 'signal' | 'redirect' | 'allowPrivateNetworks'> & {
  headers: Record<string, string>;
};

/** A partner reply with its body read. */
interface OcpiHttpReply {
  status: number;
  ok: boolean;
  headers: SafeFetchResponse['headers'];
  /** The URL that answered (the last redirect hop). */
  url: string;
  text: string;
}

/**
 * Reads a reply body up to MAX_OCPI_RESPONSE_BYTES: a declared or streamed
 * larger body is cancelled and refused, so a partner cannot exhaust memory.
 */
async function readBodyCapped(res: SafeFetchResponse, url: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OCPI_RESPONSE_BYTES) {
    await res.body?.cancel();
    throw new Error(`OCPI response from ${url} exceeds ${String(MAX_OCPI_RESPONSE_BYTES)} bytes`);
  }
  if (res.body == null) return '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (chunk.done) break;
    const value = chunk.value;
    total += value.byteLength;
    if (total > MAX_OCPI_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`OCPI response from ${url} exceeds ${String(MAX_OCPI_RESPONSE_BYTES)} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Sends one OCPI request and reads its reply, all under one timeout (a
 * partner that sends headers and then stalls the body is cut off too).
 * Redirects keep method and body; a hop to another origin drops the
 * Authorization header, so our token for this partner never reaches a host
 * the partner redirects to.
 */
async function requestOcpi(
  url: string,
  init: OcpiRequestInit,
  allowPrivateNetwork: boolean,
): Promise<OcpiHttpReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const origin = new URL(url).origin;
    let target = url;
    for (let hop = 0; hop <= MAX_OUTBOUND_REDIRECTS; hop++) {
      const headers =
        new URL(target).origin === origin ? init.headers : withoutAuthorization(init.headers);
      const res = await safeFetch(target, {
        ...init,
        headers,
        signal: controller.signal,
        redirect: 'manual',
        allowPrivateNetworks: allowPrivateNetwork,
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location == null || location === '') {
        return {
          status: res.status,
          ok: res.ok,
          headers: res.headers,
          url: target,
          text: await readBodyCapped(res, target),
        };
      }
      await res.body?.cancel();
      target = new URL(location, target).toString();
    }
    throw new Error(`Too many redirects for OCPI target: ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

function withoutAuthorization(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  );
}

export interface OcpiClientOptions {
  token: string;
  fromCountryCode: string;
  fromPartyId: string;
  toCountryCode: string;
  toPartyId: string;
  /** The partner's ocpi_partners.allow_private_network flag. */
  allowPrivateNetwork: boolean;
  /**
   * The partner's ocpi_partners.allow_raw_token flag: send the token without
   * Base64 encoding (OCPI 2.1.1 and 2.2 peers, 2.3.0 4.1 note). Default false.
   */
  rawToken?: boolean;
}

export class OcpiClient {
  private readonly token: string;
  private readonly fromCountryCode: string;
  private readonly fromPartyId: string;
  private readonly toCountryCode: string;
  private readonly toPartyId: string;
  private readonly allowPrivateNetwork: boolean;
  private readonly rawToken: boolean;

  constructor(options: OcpiClientOptions) {
    this.token = options.token;
    this.fromCountryCode = options.fromCountryCode;
    this.fromPartyId = options.fromPartyId;
    this.toCountryCode = options.toCountryCode;
    this.toPartyId = options.toPartyId;
    this.allowPrivateNetwork = options.allowPrivateNetwork;
    this.rawToken = options.rawToken ?? false;
  }

  private buildHeaders(correlationId?: string): Record<string, string> {
    const encoded = this.rawToken ? this.token : Buffer.from(this.token).toString('base64');
    return {
      Authorization: `Token ${encoded}`,
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
    const response = await requestOcpi(
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
    const response = await requestOcpi(
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
    const response = await requestOcpi(
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
    const response = await requestOcpi(
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
    const response = await requestOcpi(
      url,
      {
        method: 'DELETE',
        headers: this.buildHeaders(correlationId),
      },
      this.allowPrivateNetwork,
    );
    return this.parseResponse<T>(response, url);
  }

  private parseResponse<T>(response: OcpiHttpReply, url: string): OcpiResponseEnvelope<T> {
    const text = response.text;
    let parsed: OcpiResponseEnvelope<T>;
    try {
      parsed = JSON.parse(text) as OcpiResponseEnvelope<T>;
    } catch (err) {
      logger.error(
        { err, url, status: response.status, body: text.slice(0, 500) },
        'Failed to parse OCPI response',
      );
      throw new Error(`Failed to parse OCPI response from ${url}: ${String(response.status)}`, {
        cause: err,
      });
    }
    if (response.status >= 400) {
      logger.warn(
        { url, status: response.status, ocpiStatus: parsed.status_code },
        'OCPI request failed',
      );
      // An HTTP error is never a success, whatever the envelope says: a reply
      // without an OCPI error code is an error of the HTTP status.
      if (typeof parsed.status_code !== 'number' || parsed.status_code === OcpiStatusCode.SUCCESS) {
        throw new Error(`OCPI request to ${url} failed with HTTP ${String(response.status)}`);
      }
    }
    return parsed;
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
    const origin = new URL(url).origin;
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

      const pageUrl: string = nextUrl;
      const response = await requestOcpi(
        pageUrl,
        {
          method: 'GET',
          headers: this.buildHeaders(correlationId),
        },
        this.allowPrivateNetwork,
      );

      const parsed = this.parseResponse<unknown[]>(response, pageUrl);

      if (Array.isArray(parsed.data) && parsed.data.length > 0) {
        await onPage(parsed.data);
      }

      const next = parseLinkHeader(response.headers.get('Link'));
      // The next page must be on the origin of the first request: a partner
      // (or a host it redirected to) cannot send our token elsewhere.
      if (next != null) {
        const resolved = new URL(next, response.url);
        if (resolved.origin !== origin) {
          throw new Error(
            `OCPI pagination link leaves the partner origin ${origin}: ${resolved.origin}`,
          );
        }
        nextUrl = resolved.toString();
      } else {
        nextUrl = null;
      }
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
