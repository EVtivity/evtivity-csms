// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, sql as dsql } from 'drizzle-orm';
import {
  db,
  pkiCaCertificates,
  pkiCsrRequests,
  stationCertificates,
  writeAudit,
  certificateAuditLog,
  isPncEnabled,
} from '@evtivity/database';
import { getAuditActor } from '../lib/audit-actor.js';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getPubSub } from '../lib/pubsub.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';
import {
  successResponse,
  paginatedResponse,
  itemResponse,
  errorWith,
} from '../lib/response-schemas.js';

import { ERROR_CODES } from '../lib/error-codes.generated.js';
// OCPP 2.1 InstallCertificateUseEnumType + V2G CertificateUseEnumType
const PKI_CERTIFICATE_TYPES = [
  'V2GRootCertificate',
  'MORootCertificate',
  'CSMSRootCertificate',
  'V2GCertificateChain',
  'ManufacturerRootCertificate',
  'OEMRootCertificate',
  'ChargingStationCertificate',
] as const;

const caCertItem = z
  .object({
    id: z.number().int().min(1).describe('CA certificate ID'),
    certificateType: z.enum(PKI_CERTIFICATE_TYPES).describe('Certificate type'),
    certificate: z.string().max(20000).describe('PEM-encoded certificate'),
    serialNumber: z.string().max(255).nullable().describe('Certificate serial number'),
    issuer: z.string().max(500).nullable().describe('Issuer distinguished name'),
    subject: z.string().max(500).nullable().describe('Subject distinguished name'),
    validFrom: z.string().nullable().describe('Validity start timestamp (ISO 8601)'),
    validTo: z.string().nullable().describe('Validity end timestamp (ISO 8601)'),
    hashAlgorithm: z
      .enum(['SHA256', 'SHA384', 'SHA512'])
      .nullable()
      .describe('Hash algorithm used'),
    issuerNameHash: z
      .string()
      .max(255)
      .nullable()
      .describe('Hash of the issuer distinguished name'),
    issuerKeyHash: z.string().max(255).nullable().describe('Hash of the issuer public key'),
    status: z.enum(['active', 'expired', 'revoked']).describe('Certificate status'),
    source: z
      .enum(['manual_upload', 'hubject', 'station'])
      .nullable()
      .describe('Certificate source'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
  })
  .passthrough();

const csrItem = z
  .object({
    id: z.number().int().min(1).describe('CSR request ID'),
    stationId: z.string().nullable().describe('Charging station ID associated with this CSR'),
    csr: z.string().max(20000).describe('PEM-encoded certificate signing request'),
    certificateType: z.enum(PKI_CERTIFICATE_TYPES).describe('Certificate type requested'),
    requestId: z.number().int().min(0).nullable().describe('OCPP request ID from the station'),
    status: z
      .enum(['pending', 'submitted', 'signed', 'rejected', 'expired'])
      .describe('CSR status'),
    signedCertificateChain: z
      .string()
      .max(40000)
      .nullable()
      .describe('PEM-encoded signed certificate chain (when signed)'),
    providerReference: z
      .string()
      .max(255)
      .nullable()
      .describe('Reference ID from the PKI provider'),
    errorMessage: z.string().max(1000).nullable().describe('Error message if signing failed'),
    submittedAt: z
      .string()
      .nullable()
      .describe('Timestamp when CSR was submitted to provider (ISO 8601)'),
    completedAt: z
      .string()
      .nullable()
      .describe('Timestamp when CSR processing completed (ISO 8601)'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
  })
  .passthrough();

const stationCertItem = z
  .object({
    id: z.number().int().min(1).describe('Station certificate ID'),
    stationId: z.string().describe('Charging station ID'),
    certificateType: z.enum(PKI_CERTIFICATE_TYPES).describe('Certificate type'),
    certificate: z.string().max(20000).describe('PEM-encoded certificate'),
    serialNumber: z.string().max(255).nullable().describe('Certificate serial number'),
    issuer: z.string().max(500).nullable().describe('Issuer distinguished name'),
    subject: z.string().max(500).nullable().describe('Subject distinguished name'),
    validFrom: z.string().nullable().describe('Validity start timestamp (ISO 8601)'),
    validTo: z.string().nullable().describe('Validity end timestamp (ISO 8601)'),
    hashAlgorithm: z
      .enum(['SHA256', 'SHA384', 'SHA512'])
      .nullable()
      .describe('Hash algorithm used'),
    issuerNameHash: z
      .string()
      .max(255)
      .nullable()
      .describe('Hash of the issuer distinguished name'),
    issuerKeyHash: z.string().max(255).nullable().describe('Hash of the issuer public key'),
    parentCaId: z.number().int().min(1).nullable().describe('FK to parent CA certificate'),
    source: z
      .enum(['manual_upload', 'hubject', 'station'])
      .nullable()
      .describe('Certificate source'),
    status: z.enum(['active', 'expired', 'revoked']).describe('Certificate status'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    updatedAt: z.string().describe('Updated timestamp (ISO 8601)'),
  })
  .passthrough();

const caCertQuery = paginationQuery.extend({
  certificateType: z.enum(PKI_CERTIFICATE_TYPES).optional().describe('Filter by certificate type'),
  status: z
    .enum(['active', 'expired', 'revoked'])
    .optional()
    .describe('Filter by certificate status'),
});

const csrQuery = paginationQuery.extend({
  status: z
    .enum(['pending', 'submitted', 'signed', 'rejected', 'expired'])
    .optional()
    .describe('Filter by CSR status'),
  stationId: ID_PARAMS.stationId.optional().describe('Filter by charging station ID'),
});

const stationCertQuery = paginationQuery.extend({
  stationId: ID_PARAMS.stationId.optional().describe('Filter by charging station ID'),
  status: z
    .enum(['active', 'expired', 'revoked'])
    .optional()
    .describe('Filter by certificate status'),
});

const uploadCaCertBody = z.object({
  certificate: z.string().min(1).max(20000).describe('PEM-encoded certificate'),
  certificateType: z.enum(PKI_CERTIFICATE_TYPES).describe('Certificate type'),
  source: z
    .enum(['manual_upload', 'hubject', 'station'])
    .optional()
    .describe('Certificate source (defaults to manual_upload)'),
});

const signCsrBody = z.object({
  signedCertificateChain: z
    .string()
    .min(1)
    .max(40000)
    .describe('PEM-encoded signed certificate chain'),
});

const idParams = z.object({ id: z.coerce.number().int().min(1).describe('Resource ID') });

export function pncCertificateRoutes(app: FastifyInstance): void {
  // Gate the entire PnC certificate API on the pnc.enabled feature flag.
  // Certificate routes return 403 PNC_DISABLED when the feature is off.
  // Settings routes are exempt and registered separately in pnc-settings.ts,
  // so operators can still configure the provider while PnC is disabled.
  // Without this gate, an operator with certificates:write can still manage
  // CA certs and CSRs even after PnC has been disabled.
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/pnc/')) return;
    if (request.url.startsWith('/v1/pnc/settings')) return;
    const enabled = await isPncEnabled();
    if (!enabled) {
      await reply.status(403).send({
        error: 'Plug and Charge is disabled',
        code: 'PNC_DISABLED',
      });
    }
  });

  // --- CA Certificates ---

  app.get(
    '/pnc/ca-certificates',
    {
      onRequest: [authorize('certificates:read')],
      schema: {
        tags: ['PnC'],
        summary: 'List CA certificates',
        operationId: 'listPncCaCertificates',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(caCertQuery),
        response: { 200: paginatedResponse(caCertItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof caCertQuery>;
      const offset = (query.page - 1) * query.limit;

      const conditions = [];
      if (query.certificateType != null) {
        conditions.push(eq(pkiCaCertificates.certificateType, query.certificateType));
      }
      if (query.status != null) {
        conditions.push(eq(pkiCaCertificates.status, query.status));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, [countResult]] = await Promise.all([
        db
          .select()
          .from(pkiCaCertificates)
          .where(where)
          .orderBy(desc(pkiCaCertificates.createdAt))
          .limit(query.limit)
          .offset(offset),
        db.select({ count: count() }).from(pkiCaCertificates).where(where),
      ]);

      return { data: rows, total: countResult?.count ?? 0 } satisfies PaginatedResponse<
        (typeof rows)[number]
      >;
    },
  );

  app.post(
    '/pnc/ca-certificates',
    {
      onRequest: [authorize('certificates:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Upload a CA certificate',
        operationId: 'uploadPncCaCertificate',
        security: [{ bearerAuth: [] }],
        body: zodSchema(uploadCaCertBody),
        response: {
          200: itemResponse(caCertItem),
          400: errorWith('Invalid certificate', [ERROR_CODES.VALIDATION_ERROR]),
        },
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof uploadCaCertBody>;

      // Parse the PEM up front and extract metadata (serial, issuer, subject,
      // validity window, hashes) so list responses match the declared Zod
      // shape instead of returning null for every field. The earlier code
      // accepted any 1-20000 char blob and stored it without checking, which
      // also let malformed pastes propagate to InstallCertificate.
      let parsed: crypto.X509Certificate;
      try {
        parsed = new crypto.X509Certificate(body.certificate);
      } catch {
        await reply.status(400).send({
          error: 'certificate is not a valid PEM-encoded X.509 certificate',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const validFrom = new Date(parsed.validFrom);
      const validTo = new Date(parsed.validTo);

      const [row] = await db
        .insert(pkiCaCertificates)
        .values({
          certificateType: body.certificateType,
          certificate: body.certificate,
          source: body.source ?? 'manual_upload',
          serialNumber: parsed.serialNumber,
          issuer: parsed.issuer,
          subject: parsed.subject,
          validFrom: Number.isNaN(validFrom.getTime()) ? null : validFrom,
          validTo: Number.isNaN(validTo.getTime()) ? null : validTo,
          // OCSP-spec hashes (issuer Name DER hash, issuer SPKI hash) are
          // not derivable from the X509Certificate API without ASN.1
          // re-encoding, and they're not consulted by the OCSP flow on our
          // side anyway — stations include their own hashes in the
          // GetCertificateStatus OcspRequestData. Leave null rather than
          // populate with a wrong-shape hash.
        })
        .returning();

      if (row != null) {
        const actor = getAuditActor(request);
        await writeAudit(
          { table: certificateAuditLog, idColumn: 'certificate_id' },
          {
            entityId: String(row.id),
            entityIdSnapshot: String(row.id),
            action: 'ca_certificate_added',
            ...actor,
            after: row,
          },
          db,
          request.log,
        );
      }

      return row;
    },
  );

  app.delete(
    '/pnc/ca-certificates/:id',
    {
      onRequest: [authorize('certificates:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Delete a CA certificate',
        operationId: 'deletePncCaCertificate',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          200: successResponse,
          404: errorWith('CA certificate not found', [ERROR_CODES.CA_CERT_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParams>;

      const [deleted] = await db
        .delete(pkiCaCertificates)
        .where(eq(pkiCaCertificates.id, id))
        .returning({ id: pkiCaCertificates.id });

      if (deleted == null) {
        await reply
          .status(404)
          .send({ error: 'CA certificate not found', code: 'CA_CERT_NOT_FOUND' });
        return;
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: certificateAuditLog, idColumn: 'certificate_id' },
        {
          entityId: null,
          entityIdSnapshot: String(deleted.id),
          action: 'ca_certificate_deleted',
          ...actor,
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  // --- CSR Requests ---

  app.get(
    '/pnc/csr-requests',
    {
      onRequest: [authorize('certificates:read')],
      schema: {
        tags: ['PnC'],
        summary: 'List CSR requests',
        operationId: 'listPncCsrRequests',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(csrQuery),
        response: { 200: paginatedResponse(csrItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof csrQuery>;
      const offset = (query.page - 1) * query.limit;

      const conditions = [];
      if (query.status != null) {
        conditions.push(eq(pkiCsrRequests.status, query.status));
      }
      if (query.stationId != null) {
        conditions.push(eq(pkiCsrRequests.stationId, query.stationId));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, [countResult]] = await Promise.all([
        db
          .select()
          .from(pkiCsrRequests)
          .where(where)
          .orderBy(desc(pkiCsrRequests.createdAt), desc(pkiCsrRequests.id))
          .limit(query.limit)
          .offset(offset),
        db.select({ count: count() }).from(pkiCsrRequests).where(where),
      ]);

      return { data: rows, total: countResult?.count ?? 0 } satisfies PaginatedResponse<
        (typeof rows)[number]
      >;
    },
  );

  app.post(
    '/pnc/csr-requests/:id/sign',
    {
      onRequest: [authorize('certificates:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Sign a pending CSR request',
        description:
          'Marks the CSR signed with the operator-supplied PEM certificate and dispatches CertificateSigned to the station. The station_certificates mirror is updated when the station acknowledges via the certificate event projection. Returns 400 if the CSR is not in pending state.',
        operationId: 'signPncCsrRequest',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        body: zodSchema(signCsrBody),
        response: {
          200: successResponse,
          400: errorWith('Invalid signed certificate', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Csr not found', [ERROR_CODES.CSR_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParams>;
      const body = request.body as z.infer<typeof signCsrBody>;

      // Validate the operator-supplied PEM before storing it or pushing it
      // to the station. Without this guard a malformed paste lands in
      // pki_csr_requests, status flips to 'signed', and we publish a
      // CertificateSigned OCPP command with garbage that the station
      // either silently rejects or treats as a fault.
      try {
        const firstPemBlock = body.signedCertificateChain.split('-----END CERTIFICATE-----')[0];
        if (firstPemBlock == null || !firstPemBlock.includes('-----BEGIN CERTIFICATE-----')) {
          throw new Error('No PEM certificate block found');
        }
        new crypto.X509Certificate(firstPemBlock + '-----END CERTIFICATE-----');
      } catch {
        await reply.status(400).send({
          error: 'signedCertificateChain is not a valid PEM-encoded certificate',
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const [csrRow] = await db
        .select()
        .from(pkiCsrRequests)
        .where(and(eq(pkiCsrRequests.id, id), eq(pkiCsrRequests.status, 'pending')));

      if (csrRow == null) {
        await reply.status(404).send({ error: 'Pending CSR not found', code: 'CSR_NOT_FOUND' });
        return;
      }

      // Update CSR status
      await db
        .update(pkiCsrRequests)
        .set({
          status: 'signed',
          signedCertificateChain: body.signedCertificateChain,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(pkiCsrRequests.id, id));

      // If station is associated, dispatch CertificateSigned command
      if (csrRow.stationId != null) {
        // Look up station's OCPP ID
        const stationRows = await db.execute(
          dsql`SELECT station_id FROM charging_stations WHERE id = ${csrRow.stationId}`,
        );
        const stationRow = stationRows[0];
        if (stationRow != null) {
          const commandPayload = JSON.stringify({
            commandId: crypto.randomUUID(),
            stationId: stationRow.station_id as string,
            action: 'CertificateSigned',
            payload: {
              certificateChain: body.signedCertificateChain,
              certificateType: csrRow.certificateType,
            },
          });

          await getPubSub().publish('ocpp_commands', commandPayload);
        }
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: certificateAuditLog, idColumn: 'certificate_id' },
        {
          entityId: String(id),
          entityIdSnapshot: String(id),
          action: 'csr_signed',
          ...actor,
          after: { certificateType: csrRow.certificateType },
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  app.post(
    '/pnc/csr-requests/:id/reject',
    {
      onRequest: [authorize('certificates:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Reject a pending CSR request',
        description:
          'Marks the CSR rejected with an optional reason. The station is informed via CertificateSigned with status=Rejected so it can retry or fall back. Returns 400 if the CSR is not in pending state.',
        operationId: 'rejectPncCsrRequest',
        security: [{ bearerAuth: [] }],
        params: zodSchema(idParams),
        response: {
          200: successResponse,
          404: errorWith('Csr not found', [ERROR_CODES.CSR_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParams>;

      const [updated] = await db
        .update(pkiCsrRequests)
        .set({
          status: 'rejected',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(pkiCsrRequests.id, id), eq(pkiCsrRequests.status, 'pending')))
        .returning({ id: pkiCsrRequests.id });

      if (updated == null) {
        await reply.status(404).send({ error: 'Pending CSR not found', code: 'CSR_NOT_FOUND' });
        return;
      }

      const actor = getAuditActor(request);
      await writeAudit(
        { table: certificateAuditLog, idColumn: 'certificate_id' },
        {
          entityId: String(updated.id),
          entityIdSnapshot: String(updated.id),
          action: 'csr_rejected',
          ...actor,
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );

  // --- Station Certificates (global list for PnC management page) ---

  app.get(
    '/pnc/station-certificates',
    {
      onRequest: [authorize('certificates:read')],
      schema: {
        tags: ['PnC'],
        summary: 'List station certificates',
        operationId: 'listPncStationCertificates',
        security: [{ bearerAuth: [] }],
        querystring: zodSchema(stationCertQuery),
        response: { 200: paginatedResponse(stationCertItem) },
      },
    },
    async (request) => {
      const query = request.query as z.infer<typeof stationCertQuery>;
      const offset = (query.page - 1) * query.limit;

      const conditions = [];
      if (query.stationId != null) {
        conditions.push(eq(stationCertificates.stationId, query.stationId));
      }
      if (query.status != null) {
        conditions.push(eq(stationCertificates.status, query.status));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, [countResult]] = await Promise.all([
        db
          .select()
          .from(stationCertificates)
          .where(where)
          .orderBy(desc(stationCertificates.createdAt))
          .limit(query.limit)
          .offset(offset),
        db.select({ count: count() }).from(stationCertificates).where(where),
      ]);

      return { data: rows, total: countResult?.count ?? 0 } satisfies PaginatedResponse<
        (typeof rows)[number]
      >;
    },
  );

  // --- Refresh Root Certificates ---

  app.post(
    '/pnc/refresh-root-certificates',
    {
      onRequest: [authorize('certificates:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Refresh root certificates from provider',
        description:
          'Fetches the current root certificate set from the configured PKI provider (Hubject or manual) and upserts each into pki_ca_certificates. Used to pick up newly issued or rotated roots without manual upload. Returns 502 if the provider call fails.',
        operationId: 'refreshPncRootCertificates',
        security: [{ bearerAuth: [] }],
        response: { 200: successResponse },
      },
      // Each refresh fans out to the configured PKI provider (e.g., a
      // metered Hubject endpoint). Without a per-user rate limit a stuck
      // operator UI or a quick double-click can rapid-fire requests and
      // burn through the upstream quota.
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
          keyGenerator: (request) => {
            const userId = (request.user as unknown as Record<string, unknown> | undefined)?.[
              'userId'
            ];
            return typeof userId === 'string' ? userId : request.ip;
          },
        },
      },
    },
    async (request) => {
      // Dispatch a command to the OCPP server to refresh root certificates
      const payload = JSON.stringify({ action: 'refreshRootCertificates' });
      await getPubSub().publish('pnc_commands', payload);

      const actor = getAuditActor(request);
      await writeAudit(
        { table: certificateAuditLog, idColumn: 'certificate_id' },
        {
          entityId: null,
          entityIdSnapshot: 'root_refresh',
          action: 'root_certificates_refreshed',
          ...actor,
        },
        db,
        request.log,
      );

      return { success: true };
    },
  );
}
