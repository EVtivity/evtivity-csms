// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Helm post-install hook (templates/seed-admin-job.yaml). Creates the admin
// role and a single admin user from INITIAL_ADMIN_EMAIL/INITIAL_ADMIN_PASSWORD
// with mustResetPassword=true so the operator changes it on first login.
// Idempotent (ON CONFLICT DO NOTHING). Not used for local dev.

import argon2 from 'argon2';
import postgres from 'postgres';
import { connectionName, permissionCatalog } from '@evtivity/lib';

const DATABASE_URL = process.env['DATABASE_URL'];
const INITIAL_ADMIN_EMAIL = process.env['INITIAL_ADMIN_EMAIL'];
const INITIAL_ADMIN_PASSWORD = process.env['INITIAL_ADMIN_PASSWORD'];
const MUST_RESET_PASSWORD = process.env['INITIAL_ADMIN_MUST_RESET_PASSWORD'] !== 'false';

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!INITIAL_ADMIN_EMAIL) throw new Error('INITIAL_ADMIN_EMAIL is required');
if (!INITIAL_ADMIN_PASSWORD) throw new Error('INITIAL_ADMIN_PASSWORD is required');

// Source of truth is the permission catalog in @evtivity/lib, so a permission
// added to it flows here. Previously this file kept its own hardcoded list and
// silently drifted -- new permissions added to the lib (audit:read,
// audit:write) never reached freshly seeded admins, leaving every "History"
// tab broken with 403 until manual backfill.
const ADMIN_PERMISSIONS = permissionCatalog.defaultsFor('admin');

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
function rid(prefix: string): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += ID_CHARS.charAt(Math.floor(Math.random() * 36));
  return `${prefix}_${s}`;
}

const sql = postgres(DATABASE_URL, { connection: { application_name: connectionName() } });

try {
  const passwordHash = await argon2.hash(INITIAL_ADMIN_PASSWORD);

  const existingRole = await sql<{ id: string }[]>`SELECT id FROM roles WHERE name = 'admin'`;
  let roleId: string;
  if (existingRole.length > 0 && existingRole[0]) {
    roleId = existingRole[0].id;
  } else {
    const created = await sql<{ id: string }[]>`
      INSERT INTO roles (id, name, description, permissions)
      VALUES (${rid('rol')}, 'admin', 'Full system access', ${sql.json(['*'])})
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
    VALUES (${rid('usr')}, ${INITIAL_ADMIN_EMAIL}, ${passwordHash}, 'Admin', 'User', ${roleId}, ${MUST_RESET_PASSWORD}, true)
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email
  `;

  let adminUserId: string;
  if (insertedUser.length > 0 && insertedUser[0]) {
    const user = insertedUser[0];
    console.log(`Initial admin user created: ${user.email}`);
    adminUserId = user.id;
  } else {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${INITIAL_ADMIN_EMAIL}
    `;
    if (existing.length === 0 || !existing[0]) {
      throw new Error('Admin user lookup failed after ON CONFLICT');
    }
    adminUserId = existing[0].id;
    console.log(`Admin user already exists: ${INITIAL_ADMIN_EMAIL}`);
  }

  // Always re-assert the full permission set. Without this, permissions added
  // to the permission catalog after the admin was first created would never
  // reach existing installs -- the upgrade would create no new admin row, the
  // ON CONFLICT path would skip perm insertion, and the new feature's RBAC
  // gate would 403 until a manual SQL backfill. ON CONFLICT DO NOTHING on
  // user_permissions is safe to run on every upgrade.
  const rows = ADMIN_PERMISSIONS.map((permission) => ({ user_id: adminUserId, permission }));
  const result = await sql`
    INSERT INTO user_permissions ${sql(rows, 'user_id', 'permission')}
    ON CONFLICT DO NOTHING
  `;
  console.log(
    `Permission sync: ${String(result.count)} new of ${String(ADMIN_PERMISSIONS.length)} assigned.`,
  );
} finally {
  await sql.end();
}
