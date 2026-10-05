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
  smallint,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { chargingStations } from './assets.js';
import { driverTokens } from './drivers.js';

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

// ISO 15118 contracts the local contract CA provisions (pnc.provider =
// 'local'). A contract is an eMAID driver token bound to the vehicle PCID
// (the OEM provisioning certificate subject) that may install it. Written
// only by the API pnc-contract service. Revoked is terminal.
export const pncContractStatusEnum = pgEnum('pnc_contract_status', ['active', 'revoked']);

export const pncContracts = pgTable(
  'pnc_contracts',
  {
    id: serial('id').primaryKey(),
    driverTokenId: text('driver_token_id')
      .notNull()
      .references(() => driverTokens.id, { onDelete: 'cascade' }),
    pcid: varchar('pcid', { length: 64 }).notNull(),
    status: pncContractStatusEnum('status').notNull().default('active'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_pnc_contracts_driver_token').on(table.driverTokenId),
    index('idx_pnc_contracts_pcid_status').on(table.pcid, table.status),
  ],
);

// Contract certificates the local contract CA issued, one row per
// Get15118EVCertificate delivery. The rows give the revocation status of a
// local contract certificate (C07) and the ISO 15118-20 delivery order
// (remainingContracts). Written only by the OCPP local contract provider.
export const pncContractCertificates = pgTable(
  'pnc_contract_certificates',
  {
    id: serial('id').primaryKey(),
    contractId: integer('contract_id')
      .notNull()
      .references(() => pncContracts.id, { onDelete: 'cascade' }),
    stationId: text('station_id').references(() => chargingStations.id, { onDelete: 'set null' }),
    pcid: varchar('pcid', { length: 64 }).notNull(),
    schemaVersion: smallint('schema_version').notNull(),
    serialNumber: varchar('serial_number', { length: 64 }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_pnc_contract_certificates_serial').on(table.serialNumber),
    index('idx_pnc_contract_certificates_contract').on(table.contractId),
    index('idx_pnc_contract_certificates_delivery').on(table.stationId, table.pcid, table.issuedAt),
  ],
);
