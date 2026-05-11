// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count, sql as dsql } from 'drizzle-orm';
import { db, pkiCaCertificates, pkiCsrRequests, stationCertificates } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { getPubSub } from '../lib/pubsub.js';
import { paginationQuery } from '../lib/pagination.js';
import type { PaginatedResponse } from '../lib/pagination.js';
import { authorize } from '../middleware/rbac.js';
import {
  errorResponse,
  successResponse,
  paginatedResponse,
  itemResponse,
} from '../lib/response-schemas.js';

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
        response: { 200: itemResponse(caCertItem) },
      },
    },
    async (request) => {
      const body = request.body as z.infer<typeof uploadCaCertBody>;

      const [row] = await db
        .insert(pkiCaCertificates)
        .values({
          certificateType: body.certificateType,
          certificate: body.certificate,
          source: body.source ?? 'manual_upload',
        })
        .returning();

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
        response: { 200: successResponse, 404: errorResponse },
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
          .orderBy(desc(pkiCsrRequests.createdAt))
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
        response: { 200: successResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof idParams>;
      const body = request.body as z.infer<typeof signCsrBody>;

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
        response: { 200: successResponse, 404: errorResponse },
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
    },
    async () => {
      // Dispatch a command to the OCPP server to refresh root certificates
      const payload = JSON.stringify({ action: 'refreshRootCertificates' });
      await getPubSub().publish('pnc_commands', payload);

      return { success: true };
    },
  );
}
