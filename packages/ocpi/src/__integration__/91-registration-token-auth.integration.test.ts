// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPI server accepts the registration token the CSMS issues to a partner
// (POST /v1/ocpi/partners stores it with direction 'issued') on the version
// details endpoint, and rejects a token stored as received.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateId } from '@evtivity/lib';
import { clearRoamingCache } from '@evtivity/database';
import { buildOcpiApp } from '../app.js';

const sql = postgres(
  process.env['DATABASE_URL'] ?? 'postgres://evtivity:evtivity@localhost:5433/evtivity_test',
  { max: 2, onnotice: () => {} },
);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildOcpiApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

beforeEach(async () => {
  await sql`TRUNCATE TABLE ocpi_credentials_tokens, ocpi_partners CASCADE`;
  // The OCPI server answers 503 while roaming is off.
  await sql`
    INSERT INTO settings (key, value) VALUES ('roaming.enabled', ${sql.json(true)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
  clearRoamingCache();
});

async function partnerWithToken(direction: 'issued' | 'received'): Promise<string> {
  const partnerId = generateId('ocpiPartner');
  await sql`
    INSERT INTO ocpi_partners (id, name, country_code, party_id, status)
    VALUES (${partnerId}, 'Partner', 'NL', 'ABC', 'pending')
  `;
  const token = randomBytes(32).toString('hex');
  await sql`
    INSERT INTO ocpi_credentials_tokens (partner_id, token_hash, token_prefix, direction, is_active)
    VALUES (${partnerId}, ${await argon2.hash(token)}, ${token.slice(0, 8)}, ${direction}, true)
  `;
  return token;
}

function authHeader(token: string): { authorization: string } {
  return { authorization: `Token ${Buffer.from(token).toString('base64')}` };
}

describe('OCPI registration token', () => {
  it('opens the version details with a token the CSMS issued', async () => {
    const token = await partnerWithToken('issued');

    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1', headers: authHeader(token) });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.version).toBe('2.2.1');
  });

  it('rejects a token stored as received', async () => {
    const token = await partnerWithToken('received');

    const res = await app.inject({ method: 'GET', url: '/ocpi/2.2.1', headers: authHeader(token) });

    expect(res.statusCode).toBe(401);
  });
});
