// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createLogger } from '@evtivity/lib';
import type {
  PkiProvider,
  SignCsrResult,
  ContractCertRequest,
  ContractCertResult,
  OcspRequestData,
  OcspResult,
} from './pki-provider.js';
import { getOcspResultForStation } from './ocsp.js';

const logger = createLogger('hubject-provider');

// Hubject endpoints can hang under load. Without a
// timeout the OCPP handler thread that initiated the certificate flow
// blocks indefinitely, the station's response promise eventually rejects
// with a timeout, and a slow upstream pins worker capacity.
const HUBJECT_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, HUBJECT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface HubjectConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

export class HubjectProvider implements PkiProvider {
  private config: HubjectConfig;
  private tokenCache: TokenCache | null = null;

  constructor(config: HubjectConfig) {
    this.config = config;
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache != null && Date.now() < this.tokenCache.expiresAt - 60_000) {
      return this.tokenCache.accessToken;
    }

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const response = await fetchWithTimeout(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hubject OAuth2 token request failed: ${String(response.status)} ${text}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    logger.info('Hubject OAuth2 token refreshed');
    return this.tokenCache.accessToken;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pkcs10',
    };
  }

  async signCsr(csr: string, certificateType: string): Promise<SignCsrResult> {
    const headers = await this.authHeaders();
    const url = `${this.config.baseUrl}/.well-known/est/simpleenroll`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: csr,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hubject CSR signing failed: ${String(response.status)} ${text}`);
    }

    const certificateChain = await response.text();
    logger.info({ certificateType }, 'CSR signed via Hubject EST simpleenroll');

    return {
      certificateChain,
      providerReference: `hubject-est-${String(Date.now())}`,
    };
  }

  async getContractCertificate({ exiRequest }: ContractCertRequest): Promise<ContractCertResult> {
    const token = await this.getAccessToken();
    const url = `${this.config.baseUrl}/ccp/getSignedContractData`;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ exiRequest }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error({ status: response.status, body: text }, 'Hubject contract cert request failed');
      return { status: 'Failed', exiResponse: '' };
    }

    const data = (await response.json()) as { exiResponse: string };
    logger.info('Contract certificate retrieved from Hubject');

    return { status: 'Accepted', exiResponse: data.exiResponse };
  }

  async getOcspStatus(ocspRequestData: OcspRequestData): Promise<OcspResult> {
    // OCSP is answered by the responder in the certificate's AIA extension,
    // not by the Hubject API. The helper sends the RFC 6960 request and
    // applies the SSRF guard (private addresses only when allowlisted).
    const result = await getOcspResultForStation(ocspRequestData);
    if (result.status !== 'Accepted') {
      logger.error(
        { url: ocspRequestData.responderURL, reason: result.reason },
        'OCSP status request failed',
      );
      return { status: 'Failed', ocspResult: '' };
    }
    return { status: 'Accepted', ocspResult: result.ocspResult };
  }

  async getRootCertificates(type: string): Promise<string[]> {
    const headers = await this.authHeaders();
    const url = `${this.config.baseUrl}/.well-known/est/cacerts`;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hubject root cert fetch failed: ${String(response.status)} ${text}`);
    }

    const pemBundle = await response.text();
    const certs = pemBundle
      .split('-----END CERTIFICATE-----')
      .filter((c) => c.includes('-----BEGIN CERTIFICATE-----'))
      .map((c) => c.trim() + '\n-----END CERTIFICATE-----');

    logger.info({ count: certs.length, type }, 'Root certificates fetched from Hubject');
    return certs;
  }
}
