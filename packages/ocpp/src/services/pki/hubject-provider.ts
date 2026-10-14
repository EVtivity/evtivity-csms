// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
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

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

/** The base64 body of a PEM block, without armor or line breaks. */
function pemBody(pem: string): string {
  return pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
}

/** The PEM certificates of an EST response: certs-only PKCS#7 (base64) or PEM. */
export function estCertificates(body: string): string[] {
  if (body.includes('-----BEGIN CERTIFICATE-----')) {
    return body.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  }
  return [...new x509.X509Certificates(body.replace(/\s+/g, ''))].map((c) => c.toString('pem'));
}

/**
 * Converts an EST simpleenroll response (base64 certs-only PKCS#7) to a PEM
 * chain ordered from the leaf to the top issuer. A response that is already
 * PEM certificates is kept in the same order.
 */
export function estResponseToPemChain(body: string): string {
  if (body.includes('-----BEGIN CERTIFICATE-----')) return body.trim();
  const all = [...new x509.X509Certificates(body.replace(/\s+/g, ''))];
  if (all.length === 0) throw new Error('Hubject EST response holds no certificate');
  // The leaf issues no other certificate of the response.
  const leaf = all.find((c) => !all.some((o) => o !== c && o.issuer === c.subject)) ?? all[0];
  const ordered: x509.X509Certificate[] = [];
  let current: x509.X509Certificate | undefined = leaf;
  while (current != null && !ordered.includes(current)) {
    ordered.push(current);
    const issuerName: string = current.issuer;
    current = all.find((c) => c.subject === issuerName && !ordered.includes(c));
  }
  return ordered.map((c) => c.toString('pem')).join('\n');
}

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

  async signCsr(csr: string, certificateType: string): Promise<SignCsrResult> {
    const token = await this.getAccessToken();
    const url = `${this.config.baseUrl}/.well-known/est/simpleenroll`;

    // RFC 7030 4.2.1: the body is the DER PKCS#10 request, base64 encoded,
    // with content type application/pkcs10 (the station sends PEM).
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/pkcs10',
        'Content-Transfer-Encoding': 'base64',
        Accept: 'application/pkcs7-mime',
      },
      body: pemBody(csr),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hubject CSR signing failed: ${String(response.status)} ${text}`);
    }

    // RFC 7030 4.2.3: a certs-only PKCS#7 (CMS SignedData), base64 encoded.
    // OCPP CertificateSigned needs a PEM chain starting at the leaf.
    const certificateChain = estResponseToPemChain(await response.text());
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
    // A failure is returned with its reason, not logged here: the caller logs
    // it with the station that named the responder.
    return getOcspResultForStation(ocspRequestData);
  }

  async getRootCertificates(type: string): Promise<string[]> {
    const token = await this.getAccessToken();
    const url = `${this.config.baseUrl}/.well-known/est/cacerts`;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/pkcs7-mime' },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hubject root cert fetch failed: ${String(response.status)} ${text}`);
    }

    // RFC 7030 4.1.3: a certs-only PKCS#7, base64 encoded (PEM also accepted).
    const certs = estCertificates(await response.text());

    logger.info({ count: certs.length, type }, 'Root certificates fetched from Hubject');
    return certs;
  }
}
