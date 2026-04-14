// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import { state } from './state.js';

function buildHeaders(token: string): Record<string, string> {
  const tokenBase64 = Buffer.from(token).toString('base64');
  return {
    'Content-Type': 'application/json',
    Authorization: `Token ${tokenBase64}`,
    'X-Request-ID': crypto.randomUUID(),
    'X-Correlation-ID': crypto.randomUUID(),
    'OCPI-from-country-code': state.countryCode,
    'OCPI-from-party-id': state.partyId,
  };
}

interface OcpiEnvelope<T> {
  data: T;
  status_code: number;
  status_message: string;
}

async function parse<T>(response: Response, url: string): Promise<T> {
  const text = await response.text();
  const parsed = JSON.parse(text) as OcpiEnvelope<T>;
  if (parsed.status_code !== 1000) {
    throw new Error(
      `OCPI error ${String(parsed.status_code)} from ${url}: ${parsed.status_message}`,
    );
  }
  return parsed.data;
}

function requireToken(): string {
  if (state.theirToken == null) throw new Error('Not registered: theirToken is null');
  return state.theirToken;
}

export async function ocpiGet<T>(url: string, token?: string): Promise<T> {
  const tok = token ?? requireToken();
  const response = await fetch(url, { headers: buildHeaders(tok) });
  return parse<T>(response, url);
}

export async function ocpiPost<T>(url: string, body: unknown, token?: string): Promise<T> {
  const tok = token ?? requireToken();
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(tok),
    body: JSON.stringify(body),
  });
  return parse<T>(response, url);
}

export async function ocpiPut<T>(url: string, body: unknown, token?: string): Promise<T> {
  const tok = token ?? requireToken();
  const response = await fetch(url, {
    method: 'PUT',
    headers: buildHeaders(tok),
    body: JSON.stringify(body),
  });
  return parse<T>(response, url);
}
