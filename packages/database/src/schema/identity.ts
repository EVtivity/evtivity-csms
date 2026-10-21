// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  text,
  serial,
  varchar,
  boolean,
  timestamp,
  jsonb,
  integer,
  bigint,
  index,
  check,
  unique,
  uniqueIndex,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '../lib/id.js';
import { drivers } from './drivers.js';
import { sites } from './assets.js';

export const roles = pgTable('roles', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId('role')),
  name: varchar('name', { length: 100 }).notNull().unique(),
  description: varchar('description', { length: 500 }),
  permissions: jsonb('permissions').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('user')),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    firstName: varchar('first_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }),
    phone: varchar('phone', { length: 50 }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id),
    isActive: boolean('is_active').notNull().default(true),
    mustResetPassword: boolean('must_reset_password').notNull().default(false),
    language: varchar('language', { length: 10 }).notNull().default('en'),
    timezone: varchar('timezone', { length: 50 }).notNull().default('America/New_York'),
    themePreference: varchar('theme_preference', { length: 10 }).notNull().default('light'),
    hasAllSiteAccess: boolean('has_all_site_access').notNull().default(false),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaMethod: varchar('mfa_method', { length: 20 }),
    totpSecretEnc: varchar('totp_secret_enc', { length: 500 }),
    // The last TOTP time step a sign-in accepted: a code of that step or an
    // earlier one is refused, so an observed code cannot be replayed.
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    // How the account was created: 'password' or 'sso' (auto-provisioned by
    // a SAML sign-in). While SSO is enabled an SSO account has no password
    // sign-in, reset or change.
    authSource: varchar('auth_source', { length: 20 }).notNull().default('password'),
    // Raised by every change that must end the access tokens issued before it
    // (logout, password, MFA, role, permissions, deactivation). An access
    // token carries the version it was issued under (`sv`).
    sessionVersion: integer('session_version').notNull().default(0),
    // Per-account sign-in backoff: failed password sign-ins in a row and the
    // time until which the next one is refused.
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    loginLockedUntil: timestamp('login_locked_until', { withTimezone: true }),
    // The same for MFA codes after the password step.
    mfaFailedCount: integer('mfa_failed_count').notNull().default(0),
    mfaLockedUntil: timestamp('mfa_locked_until', { withTimezone: true }),
    // The same for factor proofs from a signed-in session, apart from sign-in.
    proofFailedCount: integer('proof_failed_count').notNull().default(0),
    proofLockedUntil: timestamp('proof_locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_users_email').on(table.email),
    index('idx_users_role_id').on(table.roleId),
    check('users_auth_source_check', sql`"auth_source" IN ('password', 'sso')`),
  ],
);

export const userTokens = pgTable(
  'user_tokens',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    type: varchar('type', { length: 20 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_user_tokens_user_id').on(table.userId),
    index('idx_user_tokens_driver_id').on(table.driverId),
    index('idx_user_tokens_token_hash').on(table.tokenHash),
    check(
      'user_tokens_exactly_one_actor',
      sql`("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL)`,
    ),
  ],
);

// Name of the temporary API key the OCTT conformance runner creates. The auth
// layer exempts this key from the per-key rate limit because the runner fires
// CSMS-initiated OCPP commands in bursts that legitimately exceed the limit.
export const OCTT_API_KEY_NAME = 'OCTT Runner (temporary)';

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    type: varchar('type', { length: 20 }).notNull().default('session'),
    name: varchar('name', { length: 255 }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    permissions: jsonb('permissions'),
    tokenSuffix: varchar('token_suffix', { length: 8 }),
    deviceId: varchar('device_id', { length: 64 }),
    // 'mobile' for a driver refresh token issued to the app, else null.
    client: varchar('client', { length: 16 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_refresh_tokens_user_id').on(table.userId),
    index('idx_refresh_tokens_driver_id').on(table.driverId),
    index('idx_refresh_tokens_token_hash').on(table.tokenHash),
    check(
      'refresh_tokens_exactly_one_actor',
      sql`("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL)`,
    ),
  ],
);

export const userPermissions = pgTable(
  'user_permissions',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: varchar('permission', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_user_permissions_user_perm').on(table.userId, table.permission),
    index('idx_user_permissions_user_id').on(table.userId),
  ],
);

export const mfaChallenges = pgTable(
  'mfa_challenges',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 255 }).notNull(),
    method: varchar('method', { length: 20 }).notNull(),
    // sign_in, proof or setup: a code confirms only its own purpose.
    purpose: varchar('purpose', { length: 16 }).notNull().default('sign_in'),
    // SHA-256 of the phone number an SMS code was sent to, else null.
    destinationHash: varchar('destination_hash', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    // Codes tried against this challenge: a guarded UPDATE counts each try
    // and refuses the challenge after MFA_CHALLENGE_MAX_ATTEMPTS.
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_mfa_challenges_user_id').on(table.userId),
    index('idx_mfa_challenges_driver_id').on(table.driverId),
    index('idx_mfa_challenges_destination_hash').on(table.destinationHash),
    check(
      'mfa_challenges_exactly_one_actor',
      sql`("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL)`,
    ),
  ],
);

// Single-use MFA recovery codes, stored as argon2id hashes. Written only by
// the API's MFA factor service.
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 255 }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_mfa_recovery_codes_user_id').on(table.userId),
    index('idx_mfa_recovery_codes_driver_id').on(table.driverId),
    check(
      'mfa_recovery_codes_exactly_one_account',
      sql`("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL)`,
    ),
  ],
);

const bytea = customType<{ data: Buffer; driverParam: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * WebAuthn credentials (passkeys and FIDO2 security keys) of an operator or a
 * driver: a second factor, and a passwordless sign-in when allowed.
 */
export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    driverId: text('driver_id').references(() => drivers.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull().unique(),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    deviceType: varchar('device_type', { length: 20 }).notNull(),
    backedUp: boolean('backed_up').notNull().default(false),
    aaguid: varchar('aaguid', { length: 36 }),
    userHandle: text('user_handle').notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_webauthn_credentials_user_id').on(table.userId),
    index('idx_webauthn_credentials_driver_id').on(table.driverId),
    check(
      'webauthn_credentials_exactly_one_account',
      sql`("user_id" IS NOT NULL AND "driver_id" IS NULL) OR ("user_id" IS NULL AND "driver_id" IS NOT NULL)`,
    ),
  ],
);

export const userSiteAssignments = pgTable(
  'user_site_assignments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId('userSiteAssignment')),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_user_site_assignments_user_id').on(table.userId),
    index('idx_user_site_assignments_site_id').on(table.siteId),
    uniqueIndex('idx_user_site_assignments_unique').on(table.userId, table.siteId),
  ],
);

export const userNotificationPreferences = pgTable(
  'user_notification_preferences',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    smsEnabled: boolean('sms_enabled').notNull().default(true),
    /** Opt-in daily AI proposal digest email (migration 0434). */
    aiDigestEmail: boolean('ai_digest_email').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_user_notification_prefs_user').on(table.userId)],
);
