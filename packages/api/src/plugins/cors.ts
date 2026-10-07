// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from '../lib/config.js';

/** Match private network and localhost origins (no hardcoded IP needed). */
function isPrivateOrigin(origin: string): boolean {
  const host = URL.parse(origin)?.hostname;
  if (host == null) return false;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.startsWith('192.168.') ||
    host.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
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
          cb(new Error('CORS not allowed'), false);
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
