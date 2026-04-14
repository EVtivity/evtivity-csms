// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config } from '../lib/config.js';

/** Match private network and localhost origins (no hardcoded IP needed). */
function isPrivateOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

export async function registerCors(app: FastifyInstance): Promise<void> {
  const raw = config.CORS_ORIGIN;
  if (raw === '') {
    throw new Error('CORS_ORIGIN environment variable is required');
  }
  if (raw === '*' && config.NODE_ENV === 'production') {
    throw new Error('CORS_ORIGIN must not be "*" in production. Set explicit origins.');
  }

  // "local" allows any private network / localhost origin dynamically
  if (raw === 'local') {
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
