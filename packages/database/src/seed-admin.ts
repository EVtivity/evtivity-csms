// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Helm post-install hook (templates/seed-admin-job.yaml). Creates the admin
// role and a single admin user from INITIAL_ADMIN_EMAIL/INITIAL_ADMIN_PASSWORD
// with mustResetPassword=true so the operator changes it on first login.
// Idempotent (ON CONFLICT DO NOTHING). Not used for local dev.

import argon2 from 'argon2';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'];
const INITIAL_ADMIN_EMAIL = process.env['INITIAL_ADMIN_EMAIL'];
const INITIAL_ADMIN_PASSWORD = process.env['INITIAL_ADMIN_PASSWORD'];

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!INITIAL_ADMIN_EMAIL) throw new Error('INITIAL_ADMIN_EMAIL is required');
if (!INITIAL_ADMIN_PASSWORD) throw new Error('INITIAL_ADMIN_PASSWORD is required');

const ADMIN_PERMISSIONS = [
  'dashboard:read',
  'dashboard:write',
  'stations:read',
  'stations:write',
  'sites:read',
  'sites:write',
  'sessions:read',
  'sessions:write',
  'drivers:read',
  'drivers:write',
  'fleets:read',
  'fleets:write',
  'reservations:read',
  'reservations:write',
  'support:read',
  'support:write',
  'payments:read',
  'payments:write',
  'pricing:read',
  'pricing:write',
  'roaming:read',
  'roaming:write',
  'smartCharging:read',
  'smartCharging:write',
  'certificates:read',
  'certificates:write',
  'conformance:read',
  'conformance:write',
  'reports:read',
  'reports:write',
  'sustainability:read',
  'sustainability:write',
  'loadManagement:read',
  'loadManagement:write',
  'logs:read',
  'logs:write',
  'users:read',
  'users:write',
  'settings.system:read',
  'settings.system:write',
  'settings.notification:read',
  'settings.notification:write',
  'settings.payment:read',
  'settings.payment:write',
  'settings.integrations:read',
  'settings.integrations:write',
  'settings.security:read',
  'settings.security:write',
  'settings.apiKeys:read',
  'settings.apiKeys:write',
  'settings.firmware:read',
  'settings.firmware:write',
  'settings.stationConfig:read',
  'settings.stationConfig:write',
  'settings.smartCharging:read',
  'settings.smartCharging:write',
  'settings.ai:read',
  'settings.ai:write',
  'settings.conformance:read',
  'settings.conformance:write',
];

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
function rid(prefix: string): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += ID_CHARS.charAt(Math.floor(Math.random() * 36));
  return `${prefix}_${s}`;
}

const sql = postgres(DATABASE_URL);

try {
  const passwordHash = await argon2.hash(INITIAL_ADMIN_PASSWORD);

  const existingRole = await sql<{ id: string }[]>`SELECT id FROM roles WHERE name = 'admin'`;
  let roleId: string;
  if (existingRole.length > 0 && existingRole[0]) {
    roleId = existingRole[0].id;
  } else {
    const created = await sql<{ id: string }[]>`
      INSERT INTO roles (id, name, description, permissions)
      VALUES (${rid('rol')}, 'admin', 'Full system access', ${JSON.stringify(['*'])}::jsonb)
      ON CONFLICT (name) DO NOTHING
      RETURNING id
    `;
    if (created.length > 0 && created[0]) {
      roleId = created[0].id;
    } else {
      const refetched = await sql<{ id: string }[]>`SELECT id FROM roles WHERE name = 'admin'`;
      if (refetched.length === 0 || !refetched[0])
        throw new Error('Failed to create or load admin role');
      roleId = refetched[0].id;
    }
  }

  const insertedUser = await sql<{ id: string; email: string }[]>`
    INSERT INTO users (id, email, password_hash, first_name, last_name, role_id, must_reset_password, has_all_site_access)
    VALUES (${rid('usr')}, ${INITIAL_ADMIN_EMAIL}, ${passwordHash}, 'Admin', 'User', ${roleId}, true, true)
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email
  `;

  if (insertedUser.length > 0 && insertedUser[0]) {
    const user = insertedUser[0];
    console.log(`Initial admin user created: ${user.email}`);

    const rows = ADMIN_PERMISSIONS.map((permission) => ({ user_id: user.id, permission }));
    await sql`
      INSERT INTO user_permissions ${sql(rows, 'user_id', 'permission')}
      ON CONFLICT DO NOTHING
    `;
    console.log(`Assigned ${String(ADMIN_PERMISSIONS.length)} permissions to admin.`);
  } else {
    console.log(`Admin user already exists: ${INITIAL_ADMIN_EMAIL}`);
  }
} finally {
  await sql.end();
}
