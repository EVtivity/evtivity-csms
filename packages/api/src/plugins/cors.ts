// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { BlockList, isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ForbiddenError } from '@evtivity/lib';
import { config } from '../lib/config.js';

// Loopback and RFC 1918 private ranges: the addresses a LAN install serves from.
const LOCAL_ADDRESSES = new BlockList();
LOCAL_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4');
LOCAL_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4');
LOCAL_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4');
LOCAL_ADDRESSES.addAddress('::1', 'ipv6');

/**
 * Whether an origin is `localhost` or an IP literal on loopback or a private
 * network. The host is parsed as an address, so a public name with a private
 * looking prefix (`10.evil.com`, `192.168.evil.com`) is not local.
 */
function isPrivateOrigin(origin: string): boolean {
  const parsed = URL.parse(origin);
  if (parsed == null) return false;
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (host === 'localhost') return true;
  const family = isIP(host);
  if (family === 4) return LOCAL_ADDRESSES.check(host, 'ipv4');
  if (family === 6) return LOCAL_ADDRESSES.check(host, 'ipv6');
  return false;
}

export async function registerCors(app: FastifyInstance): Promise<void> {
  const raw = config.CORS_ORIGIN;
  if (raw === '') {
    throw new Error('CORS_ORIGIN environment variable is required');
  }
  if (raw === '*' && config.NODE_ENV === 'production') {
    throw new Error('CORS_ORIGIN must not be "*" in production. Set explicit origins.');
  }

  // "local" allows any private network / localhost origin dynamically. Also
  // allows same-origin requests regardless of network class so the dashboard
  // works behind port-forwarded public hostnames -- the browser sends the
  // Origin header even on same-origin fetch+credentials calls. Detect those
  // by comparing the Origin hostname to the request Host header in an
  // onRequest hook and clear the Origin so @fastify/cors hits its
  // null-origin allow branch. @fastify/cors invokes the origin callback
  // with the fastify instance as `this`, so we cannot read the request
  // from inside the callback itself; pre-processing the header is the
  // cleanest hand-off.
  if (raw === 'local') {
    app.addHook('onRequest', (request, _reply, done) => {
      const origin = request.headers.origin;
      const host = request.headers.host;
      const xfHost = request.headers['x-forwarded-host'];
      if (typeof origin === 'string' && (typeof host === 'string' || typeof xfHost === 'string')) {
        // A malformed Origin is left untouched for the cors plugin to reject.
        const url = URL.parse(origin);
        if (url != null) {
          // Compare against host AND x-forwarded-host since reverse proxies
          // and NAT port-forwarders sometimes rewrite the Host header (strip
          // or replace the port). Also accept when only the hostname matches
          // -- a port-forward at port 80/443 routing to internal port 7100
          // produces an Origin port that the API never sees in its Host.
          const candidates: string[] = [];
          if (typeof host === 'string') candidates.push(host);
          if (typeof xfHost === 'string') candidates.push(xfHost);
          const originHost = url.host;
          const originHostname = url.hostname;
          const matches = candidates.some(
            (h) => h === originHost || h === originHostname || h.split(':')[0] === originHostname,
          );
          if (matches) {
            delete request.headers.origin;
          }
        }
      }
      done();
    });

    await app.register(cors, {
      origin: (origin, cb) => {
        if (origin == null || isPrivateOrigin(origin)) {
          cb(null, true);
        } else {
          // AppError: the app error handler answers 403 with the standard body.
          cb(new ForbiddenError('CORS origin not allowed'), false);
        }
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      credentials: true,
    });
    return;
  }

  const origin = raw.includes(',') ? raw.split(',').map((s) => s.trim()) : raw;

  await app.register(cors, {
    origin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  });
}
