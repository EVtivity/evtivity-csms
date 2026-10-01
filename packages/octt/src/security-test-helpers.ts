// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { TestContext } from './types.js';

/** A fresh passwordString of `length` characters (16-20 for 1.6, up to 40 for 2.1). */
export function newTestPassword(length = 20): string {
  return ('OCTT' + randomBytes(32).toString('hex')).slice(0, length);
}

/**
 * Drops the test client's connection and reconnects with new settings, as a
 * station does after accepting a new password or security profile. Resolves
 * true once connected, false after the timeout.
 */
export function reconnectWith(
  ctx: TestContext,
  settings: { password?: string; securityProfile?: number; serverUrl?: string },
  timeoutMs = 40_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    ctx.client.setDisconnectedHandler(() => {});
    ctx.client.setConnectedHandler(() => {
      clearTimeout(timer);
      resolve(true);
    });
    ctx.client.updateConnection(settings);
    ctx.client.simulateConnectionLoss();
  });
}

/**
 * Opens a separate WebSocket with the given credentials and reports the HTTP
 * status of a rejected upgrade (101 when it was accepted).
 */
export function tryConnect(
  ctx: TestContext,
  opts: { serverUrl: string; password?: string },
): Promise<number> {
  return new Promise((resolve) => {
    const headers: Record<string, string> =
      opts.password != null
        ? {
            authorization:
              'Basic ' + Buffer.from(`${ctx.stationId}:${opts.password}`).toString('base64'),
          }
        : {};
    // Same TLS verification setting as the test client (OcppClient).
    const ws = new WebSocket(`${opts.serverUrl}/${ctx.stationId}`, [ctx.client.protocol], {
      headers,
      rejectUnauthorized: process.env['TLS_REJECT_UNAUTHORIZED'] === 'true',
    });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      ws.terminate();
    });
    ws.on('error', () => {
      resolve(0);
    });
  });
}

/**
 * Waits until the CSMS has marked the test station online. The connection is
 * recorded asynchronously, so an operator action sent right after
 * BootNotification could otherwise see the station as offline.
 */
export async function waitForOnline(ctx: TestContext, timeoutMs = 10_000): Promise<boolean> {
  if (ctx.callApi == null || ctx.stationDbId == null) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ctx.callApi('GET', `/stations/${ctx.stationDbId}`);
    if (res.body['isOnline'] === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/**
 * Signs the station's pending CSR the way an operator does with the manual PKI
 * provider (Certificates > CSR requests > Sign), so the CSMS sends
 * CertificateSigned. Returns an error description, or null on success.
 */
export async function signPendingCsr(
  ctx: TestContext,
  certificateChain: string,
): Promise<string | null> {
  if (ctx.callApi == null || ctx.stationDbId == null) return 'API client not available';
  const list = await ctx.callApi(
    'GET',
    `/pnc/csr-requests?stationId=${ctx.stationDbId}&status=pending&limit=1`,
  );
  const csr = (list.body['data'] as { id?: string | number }[] | undefined)?.[0];
  if (csr?.id == null) return `No pending CSR (HTTP ${String(list.status)})`;
  const signed = await ctx.callApi('POST', `/pnc/csr-requests/${String(csr.id)}/sign`, {
    signedCertificateChain: certificateChain,
  });
  return signed.status === 200 ? null : `Sign failed: HTTP ${String(signed.status)}`;
}

/** Polls `received` until it returns true or the timeout passes. */
export async function waitFor(received: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!received() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return received();
}

/** OCPP passwordString characters (OCPP 2.1 Part 2 2.1.4). */
export function isPasswordString(value: string): boolean {
  return /^[a-zA-Z0-9*\-_=:+|@.]+$/.test(value);
}
