// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { chargingStations } from './assets.js';

export const certificateStatusEnum = pgEnum('certificate_status', ['active', 'expired', 'revoked']);

export const csrStatusEnum = pgEnum('csr_status', [
  'pending',
  'submitted',
  'signed',
  'rejected',
  'expired',
]);

export const pkiCaCertificates = pgTable(
  'pki_ca_certificates',
  {
    id: serial('id').primaryKey(),
    certificateType: varchar('certificate_type', { length: 50 }).notNull(),
    certificate: text('certificate').notNull(),
    serialNumber: varchar('serial_number', { length: 255 }),
    issuer: varchar('issuer', { length: 500 }),
    subject: varchar('subject', { length: 500 }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    hashAlgorithm: varchar('hash_algorithm', { length: 10 }),
    issuerNameHash: varchar('issuer_name_hash', { length: 128 }),
    issuerKeyHash: varchar('issuer_key_hash', { length: 128 }),
    status: certificateStatusEnum('status').notNull().default('active'),
    source: varchar('source', { length: 50 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_pki_ca_cert_type_status').on(table.certificateType, table.status)],
);

export const pkiCsrRequests = pgTable(
  'pki_csr_requests',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'set null' }),
    csr: text('csr').notNull(),
    certificateType: varchar('certificate_type', { length: 50 }).notNull(),
    requestId: integer('request_id'),
    status: csrStatusEnum('status').notNull().default('pending'),
    signedCertificateChain: text('signed_certificate_chain'),
    providerReference: varchar('provider_reference', { length: 500 }),
    errorMessage: text('error_message'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_pki_csr_station_status').on(table.stationId, table.status)],
);

export const stationCertificates = pgTable(
  'station_certificates',
  {
    id: serial('id').primaryKey(),
    stationId: text('station_id')
      .notNull()
      .references(() => chargingStations.id, { onDelete: 'cascade' }),
    certificateType: varchar('certificate_type', { length: 50 }).notNull(),
    certificate: text('certificate').notNull(),
    serialNumber: varchar('serial_number', { length: 255 }),
    issuer: varchar('issuer', { length: 500 }),
    subject: varchar('subject', { length: 500 }),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),
    hashAlgorithm: varchar('hash_algorithm', { length: 10 }),
    issuerNameHash: varchar('issuer_name_hash', { length: 128 }),
    issuerKeyHash: varchar('issuer_key_hash', { length: 128 }),
    parentCaId: integer('parent_ca_id').references(() => pkiCaCertificates.id, {
      onDelete: 'set null',
    }),
    source: varchar('source', { length: 50 }),
    status: certificateStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_station_certificates_station_id').on(table.stationId),
    index('idx_station_certificates_status').on(table.status),
  ],
);
