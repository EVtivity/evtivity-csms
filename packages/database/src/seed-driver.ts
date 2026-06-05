// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Helm post-install hook AND docker-compose migrate container. Creates a
// single driver from INITIAL_DRIVER_EMAIL / INITIAL_DRIVER_PASSWORD so the
// portal has a working login on a fresh `docker compose up -d`. Idempotent:
// skips the insert when a driver with that email already exists. Email is
// marked verified so the portal login flow does not block on the verify-
// email page.

import argon2 from 'argon2';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'];
const INITIAL_DRIVER_EMAIL = process.env['INITIAL_DRIVER_EMAIL'];
const INITIAL_DRIVER_PASSWORD = process.env['INITIAL_DRIVER_PASSWORD'];

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!INITIAL_DRIVER_EMAIL) throw new Error('INITIAL_DRIVER_EMAIL is required');
if (!INITIAL_DRIVER_PASSWORD) throw new Error('INITIAL_DRIVER_PASSWORD is required');

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
function rid(prefix: string): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += ID_CHARS.charAt(Math.floor(Math.random() * 36));
  return `${prefix}_${s}`;
}

const sql = postgres(DATABASE_URL);

try {
  // drivers.email has a partial unique index (WHERE email IS NOT NULL) added
  // in migration 0022. ON CONFLICT against a partial index requires matching
  // the WHERE clause exactly; a plain SELECT-then-INSERT is simpler and just
  // as race-safe here because the migrate container runs at most once per
  // compose up.
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM drivers WHERE email = ${INITIAL_DRIVER_EMAIL}
  `;

  if (existing.length > 0) {
    // Portal login filters on registration_source = 'portal'; heal rows with
    // any other source so this driver can always log in via the portal.
    await sql`
      UPDATE drivers SET registration_source = 'portal'
      WHERE email = ${INITIAL_DRIVER_EMAIL} AND registration_source <> 'portal'
    `;
    console.log(`Driver already exists: ${INITIAL_DRIVER_EMAIL}`);
  } else {
    const passwordHash = await argon2.hash(INITIAL_DRIVER_PASSWORD);
    const inserted = await sql<{ id: string; email: string }[]>`
      INSERT INTO drivers (
        id, first_name, last_name, email, password_hash,
        registration_source, email_verified, is_active
      )
      VALUES (
        ${rid('drv')}, 'Demo', 'Driver', ${INITIAL_DRIVER_EMAIL}, ${passwordHash},
        'portal', true, true
      )
      RETURNING id, email
    `;
    if (inserted.length > 0 && inserted[0]) {
      console.log(`Initial driver created: ${inserted[0].email}`);
    }
  }
} finally {
  await sql.end();
}
