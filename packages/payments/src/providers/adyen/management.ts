// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PaymentProviderPermissionError, PaymentProviderUnavailableError } from '../../errors.js';
import { AdyenApiError, AdyenCheckoutClient } from './client.js';
import type { AdyenEnvironment, AdyenRequest } from './client.js';

/**
 * Management API v3 base URLs. Live is a fixed host, without the live URL
 * prefix of the Checkout API
 * (https://docs.adyen.com/api-explorer/Management/3/overview).
 */
export const ADYEN_MANAGEMENT_TEST_BASE_URL = 'https://management-test.adyen.com/v3';
export const ADYEN_MANAGEMENT_LIVE_BASE_URL = 'https://management-live.adyen.com/v3';

export function adyenManagementBaseUrl(environment: AdyenEnvironment): string {
  return environment === 'live' ? ADYEN_MANAGEMENT_LIVE_BASE_URL : ADYEN_MANAGEMENT_TEST_BASE_URL;
}

/** The role the credential needs to list, create and update webhooks. */
export const ADYEN_WEBHOOK_ROLE = 'Management API - Webhooks read and write';

/** Description that marks the merchant webhook EVtivity manages. */
export const ADYEN_WEBHOOK_DESCRIPTION = 'EVtivity payments';

/**
 * Event codes EVtivity enables on its standard webhook (plan B6.5): the
 * handled codes, then the ones it logs and ignores. Sent on every create and
 * update, because a new standard webhook leaves EXPIRE out by default (spike
 * B1).
 */
export const ADYEN_WEBHOOK_EVENT_CODES = [
  'AUTHORISATION',
  'AUTHORISATION_ADJUSTMENT',
  'CAPTURE',
  'CAPTURE_FAILED',
  'CANCELLATION',
  'TECHNICAL_CANCEL',
  'REFUND',
  'REFUND_FAILED',
  'CHARGEBACK',
  'EXPIRE',
  'RECURRING_CONTRACT',
  'REFUNDED_REVERSED',
  'NOTIFICATION_OF_CHARGEBACK',
] as const;

/** Roles as `/me` lists them; Adyen writes the separator as a hyphen or a dash. */
function normalizeRole(role: string): string {
  return (
    role
      .replace(/[‐-―-]/g, '-')
      // Space the hyphen, then collapse the whitespace around it. One `\s*-\s*`
      // pass would be quadratic on a long run of spaces without a hyphen.
      .replace(/-/g, ' - ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

export function hasAdyenWebhookRole(roles: readonly string[]): boolean {
  const wanted = normalizeRole(ADYEN_WEBHOOK_ROLE);
  return roles.some((role) => normalizeRole(role) === wanted);
}

/** The fields of a Management API webhook EVtivity reads. */
export interface AdyenWebhook {
  id: string;
  type?: string;
  url: string;
  description?: string;
  username?: string;
  hasPassword?: boolean;
  active: boolean;
  additionalSettings?: { includeEventCodes?: string[] };
}

/** Body of a webhook create or update. Holds the Basic auth password: never log it. */
export interface AdyenWebhookWrite {
  type?: 'standard';
  url?: string;
  active?: boolean;
  communicationFormat?: 'json';
  encryptionProtocol?: 'TLSv1.3' | 'TLSv1.2' | 'HTTP';
  acceptsExpiredCertificate?: boolean;
  acceptsSelfSignedCertificate?: boolean;
  acceptsUntrustedRootCertificate?: boolean;
  username?: string;
  password?: string;
  description?: string;
  additionalSettings?: { includeEventCodes: string[] };
}

export interface AdyenCredentialInfo {
  roles: string[];
  allowedOrigins: string[];
}

export interface AdyenWebhookTestResult {
  status: string;
  responseCode: string | null;
  output: string | null;
}

interface AdyenWebhookList {
  data?: AdyenWebhook[];
  pagesTotal?: number;
}

interface AdyenWebhookTestResponse {
  data?: Array<{ status?: string; responseCode?: string; output?: string }>;
}

const PAGE_SIZE = 100;

export interface AdyenManagementClientOptions {
  apiKey: string;
  merchantAccount: string;
  environment: AdyenEnvironment;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/**
 * The Management API v3 endpoints for the merchant's standard webhook
 * (https://docs.adyen.com/api-explorer/Management/3/post/merchants/(merchantId)/webhooks).
 * Uses the request helper of the Checkout client (X-API-Key, retries of a
 * GET). A 403 means the credential lacks the role and throws
 * PaymentProviderPermissionError.
 */
export class AdyenManagementClient {
  private readonly http: AdyenCheckoutClient;
  private readonly merchantPath: string;

  constructor(options: AdyenManagementClientOptions) {
    this.http = new AdyenCheckoutClient({
      apiKey: options.apiKey,
      baseUrl: adyenManagementBaseUrl(options.environment),
      ...(options.fetch != null ? { fetch: options.fetch } : {}),
      ...(options.sleep != null ? { sleep: options.sleep } : {}),
      ...(options.maxRetries != null ? { maxRetries: options.maxRetries } : {}),
    });
    this.merchantPath = `/merchants/${encodeURIComponent(options.merchantAccount)}/webhooks`;
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  private async request<T>(req: AdyenRequest, role: string): Promise<T> {
    try {
      return await this.http.request<T>(req);
    } catch (err) {
      if (err instanceof AdyenApiError && err.status === 403) {
        throw new PaymentProviderPermissionError('adyen', role, { cause: err });
      }
      throw err;
    }
  }

  /** The credential's roles and allowed origins (any Management API role may call it). */
  async me(): Promise<AdyenCredentialInfo> {
    const body = await this.request<{
      roles?: unknown;
      allowedOrigins?: Array<{ domain?: unknown }>;
    }>({ method: 'GET', path: '/me' }, 'Management API');
    const roles = Array.isArray(body.roles)
      ? body.roles.filter((r): r is string => typeof r === 'string')
      : [];
    const allowedOrigins = (body.allowedOrigins ?? [])
      .map((o) => o.domain)
      .filter((d): d is string => typeof d === 'string');
    return { roles, allowedOrigins };
  }

  /** Every webhook of the merchant account, all pages. */
  async listWebhooks(): Promise<AdyenWebhook[]> {
    const all: AdyenWebhook[] = [];
    for (let page = 1; ; page++) {
      const body = await this.request<AdyenWebhookList>(
        {
          method: 'GET',
          path: this.merchantPath,
          query: { pageNumber: String(page), pageSize: String(PAGE_SIZE) },
        },
        ADYEN_WEBHOOK_ROLE,
      );
      all.push(...(body.data ?? []));
      if (page >= (body.pagesTotal ?? 0)) return all;
    }
  }

  async createWebhook(body: AdyenWebhookWrite): Promise<AdyenWebhook> {
    const created = await this.request<Partial<AdyenWebhook> | undefined>(
      { method: 'POST', path: this.merchantPath, body },
      ADYEN_WEBHOOK_ROLE,
    );
    if (typeof created?.id !== 'string' || created.id === '') {
      throw new PaymentProviderUnavailableError('Adyen webhook create returned no id');
    }
    return { ...created, id: created.id, url: created.url ?? '', active: created.active ?? false };
  }

  /** The answer reports the state before the update (spike B1); read it back for the truth. */
  async updateWebhook(id: string, body: AdyenWebhookWrite): Promise<void> {
    await this.request<AdyenWebhook>(
      { method: 'PATCH', path: `${this.merchantPath}/${encodeURIComponent(id)}`, body },
      ADYEN_WEBHOOK_ROLE,
    );
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request<undefined>(
      { method: 'DELETE', path: `${this.merchantPath}/${encodeURIComponent(id)}` },
      ADYEN_WEBHOOK_ROLE,
    );
  }

  /** A new HMAC key for the webhook (64 hex characters). The old key stops being used. */
  async generateHmac(id: string): Promise<string> {
    const body = await this.request<{ hmacKey?: unknown }>(
      { method: 'POST', path: `${this.merchantPath}/${encodeURIComponent(id)}/generateHmac` },
      ADYEN_WEBHOOK_ROLE,
    );
    if (typeof body.hmacKey !== 'string' || body.hmacKey === '') {
      throw new PaymentProviderUnavailableError('Adyen generateHmac returned no key');
    }
    return body.hmacKey;
  }

  /**
   * Asks Adyen to send a sample event to the webhook. Only status, response
   * code and output are returned: `requestSent` echoes a signed sample body.
   */
  async testWebhook(id: string, types: string[]): Promise<AdyenWebhookTestResult> {
    const body = await this.request<AdyenWebhookTestResponse>(
      {
        method: 'POST',
        path: `${this.merchantPath}/${encodeURIComponent(id)}/test`,
        body: { types },
      },
      ADYEN_WEBHOOK_ROLE,
    );
    const first = body.data?.[0];
    return {
      status: first?.status ?? 'failed',
      responseCode: first?.responseCode ?? null,
      output: first?.output ?? null,
    };
  }
}
