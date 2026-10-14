// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The local ISO 15118 contract CA (pnc.provider = 'local') and its contracts.
//
// The CA lives in the setting pnc.local.caEnc (encrypted bundle of
// certificates and private keys). It is created once here and never returned
// by any route; the generic settings routes do not expose it either.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, settings, settingAuditLog, writeAudit } from '@evtivity/database';
import { encryptString, decryptString } from '@evtivity/lib';
import type { LocalContractCa } from '@evtivity/ocpp';
import {
  addCpoSubCas,
  createLocalContractCa,
  describeLocalContractCa,
  hasCpoSubCas,
  parseLocalContractCa,
} from '@evtivity/ocpp';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { ID_PARAMS } from '../lib/id-validation.js';
import { authorize } from '../middleware/rbac.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { config as apiConfig } from '../lib/config.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import * as contractService from '../services/pnc-contract.service.js';
import { tokenActorOf } from '../services/token.service.js';

// Plug and Charge settings and the contract CA serve every site: company-wide,
// so a site-restricted user gets this 404 before any read or write
// (requireAllSiteAccess, features/site-access-control.md).
const ALL_SITES_SETTING_NOT_FOUND = {
  error: 'Setting not found',
  code: 'SETTING_NOT_FOUND',
} as const;

const CA_KEY = 'pnc.local.caEnc';

const caCertificate = z
  .object({
    schema: z.union([z.literal(2), z.literal(20)]).describe('ISO 15118 edition (2 or 20)'),
    role: z
      .enum([
        'moRoot',
        'moSubCa1',
        'moSubCa2',
        'cpsRoot',
        'cpsSubCa1',
        'cpsSubCa2',
        'cpsLeaf',
        'cpoSubCa1',
        'cpoSubCa2',
      ])
      .describe('Position in the hierarchy'),
    subject: z.string().describe('Subject distinguished name'),
    serialNumber: z.string().describe('Serial number (hex)'),
    validFrom: z.string().describe('Validity start (ISO 8601)'),
    validTo: z.string().describe('Validity end (ISO 8601)'),
    certificate: z
      .string()
      .describe('PEM certificate (public), for example the V2G root to install on stations'),
  })
  .passthrough();
const localCaStatus = z
  .object({
    configured: z.boolean().describe('Whether the local contract CA exists'),
    createdAt: z.string().nullable().describe('When the CA was created (ISO 8601)'),
    cpoSubCa: z
      .boolean()
      .describe(
        'Whether the CA has the CPO Sub-CAs that sign charging station V2G certificates automatically',
      ),
    certificates: z
      .array(caCertificate)
      .describe('CA certificates of both hierarchies (no private keys)'),
  })
  .passthrough();

const contractItem = z
  .object({
    id: z.number().int().describe('Contract ID'),
    driverId: z.string().describe('Driver ID'),
    driverTokenId: z.string().describe('ID of the eMAID driver token'),
    emaid: z.string().describe('eMAID (contract ID) the contract certificates carry'),
    pcid: z.string().describe('PCID of the vehicle allowed to install the contract'),
    status: z.enum(['active', 'revoked']).describe('Contract status (revoked is final)'),
    createdAt: z.string().describe('Created timestamp (ISO 8601)'),
    revokedAt: z.string().nullable().describe('Revoked timestamp (ISO 8601)'),
  })
  .passthrough();

const driverParams = z.object({ id: ID_PARAMS.driverId.describe('Driver ID') });
const contractParams = z.object({
  id: ID_PARAMS.driverId.describe('Driver ID'),
  contractId: z.coerce.number().int().min(1).describe('Contract ID'),
});
const createContractBody = z.object({
  pcid: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/)
    .describe('PCID of the vehicle (the CN of its OEM provisioning certificate)'),
});

function encryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  return key;
}

const NOT_CONFIGURED = { configured: false, createdAt: null, cpoSubCa: false, certificates: [] };

function statusOf(ca: LocalContractCa): z.infer<typeof localCaStatus> {
  return {
    configured: true,
    createdAt: ca.createdAt,
    cpoSubCa: hasCpoSubCas(ca),
    certificates: describeLocalContractCa(ca),
  };
}

/** The stored CA and its ciphertext (the compare-and-set of the CPO Sub-CA update reads it). */
async function loadCa(): Promise<{ ca: LocalContractCa; stored: string } | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, CA_KEY));
  const value = row?.value;
  if (typeof value !== 'string' || value === '') return null;
  const ca = parseLocalContractCa(decryptString(value, encryptionKey()));
  return ca == null ? null : { ca, stored: value };
}

async function readCa(): Promise<z.infer<typeof localCaStatus>> {
  const loaded = await loadCa();
  return loaded == null ? NOT_CONFIGURED : statusOf(loaded.ca);
}

async function publishCaChange(request: {
  log: { warn: (o: unknown, m: string) => void };
}): Promise<void> {
  try {
    await getPubSub().publish('cache_invalidate', JSON.stringify({ cache: 'pkiCaCertificates' }));
  } catch (err: unknown) {
    request.log.warn({ err }, 'Failed to publish local contract CA cache invalidation');
  }
}

export function pncLocalRoutes(app: FastifyInstance): void {
  // Under /pnc/settings so the CA can be set up before Plug and Charge is enabled.
  app.get(
    '/pnc/settings/local-ca',
    {
      onRequest: [authorize('settings.integrations:read')],
      schema: {
        tags: ['PnC'],
        summary: 'Get the local contract CA',
        description:
          'Certificates of the ISO 15118 contract CA the CSMS runs for pnc.provider = local. Private keys are never returned.',
        operationId: 'getPncLocalCa',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(localCaStatus),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      return readCa();
    },
  );

  app.post(
    '/pnc/settings/local-ca',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Create the local contract CA',
        description:
          'Generates the ISO 15118-2 (secp256r1) and ISO 15118-20 (secp521r1) Mobility Operator and certificate provisioning service hierarchies, with the CPO Sub-CAs that sign charging station V2G certificates. The private keys are stored encrypted. A CA is created once.',
        operationId: 'createPncLocalCa',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(localCaStatus),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          409: errorWith('Local contract CA exists', [ERROR_CODES.LOCAL_CA_EXISTS]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const ca = await createLocalContractCa();
      const encrypted = encryptString(JSON.stringify(ca), encryptionKey());
      // Only an empty (or missing) setting is replaced, so two concurrent
      // requests cannot both create a CA.
      await db
        .insert(settings)
        .values({ key: CA_KEY, value: '' })
        .onConflictDoNothing({ target: settings.key });
      const [written] = await db
        .update(settings)
        .set({ value: encrypted, updatedAt: new Date() })
        .where(and(eq(settings.key, CA_KEY), eq(settings.value, '')))
        .returning({ key: settings.key });
      if (written == null) {
        await reply
          .status(409)
          .send({ error: 'A local contract CA exists', code: 'LOCAL_CA_EXISTS' });
        return;
      }

      await writeAudit(
        { table: settingAuditLog, idColumn: 'setting_key' },
        {
          entityId: CA_KEY,
          entityIdSnapshot: CA_KEY,
          action: 'updated',
          ...getAuditActor(request),
          before: { key: CA_KEY, configured: false },
          after: { key: CA_KEY, configured: true, createdAt: ca.createdAt },
        },
        db,
        request.log,
      );
      await publishCaChange(request);
      return statusOf(ca);
    },
  );

  app.post(
    '/pnc/settings/local-ca/cpo-sub-ca',
    {
      onRequest: [authorize('settings.integrations:write')],
      schema: {
        tags: ['PnC'],
        summary: 'Add the CPO Sub-CAs to the local contract CA',
        description:
          'Adds CPO Sub-CA 1 and 2 under the V2G root of both hierarchies to a local contract CA created without them. With pnc.provider = local, CPO Sub-CA 2 signs the V2G certificates charging stations request (SignCertificate); station TLS certificates stay manual. The private keys are stored encrypted.',
        operationId: 'addPncLocalCpoSubCa',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(localCaStatus),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          409: errorWith('No local contract CA, or the CPO Sub-CAs exist', [
            ERROR_CODES.LOCAL_CA_NOT_CONFIGURED,
            ERROR_CODES.LOCAL_CPO_SUB_CA_EXISTS,
          ]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const loaded = await loadCa();
      if (loaded == null) {
        await reply
          .status(409)
          .send({ error: 'No local contract CA', code: 'LOCAL_CA_NOT_CONFIGURED' });
        return;
      }
      if (hasCpoSubCas(loaded.ca)) {
        await reply
          .status(409)
          .send({ error: 'The CPO Sub-CAs exist', code: 'LOCAL_CPO_SUB_CA_EXISTS' });
        return;
      }
      const next = await addCpoSubCas(loaded.ca);
      // Compare-and-set on the stored bundle: a concurrent request adds them once.
      const [written] = await db
        .update(settings)
        .set({ value: encryptString(JSON.stringify(next), encryptionKey()), updatedAt: new Date() })
        .where(and(eq(settings.key, CA_KEY), eq(settings.value, loaded.stored)))
        .returning({ key: settings.key });
      if (written == null) {
        await reply
          .status(409)
          .send({ error: 'The CPO Sub-CAs exist', code: 'LOCAL_CPO_SUB_CA_EXISTS' });
        return;
      }
      await writeAudit(
        { table: settingAuditLog, idColumn: 'setting_key' },
        {
          entityId: CA_KEY,
          entityIdSnapshot: CA_KEY,
          action: 'updated',
          ...getAuditActor(request),
          before: { key: CA_KEY, cpoSubCa: false },
          after: { key: CA_KEY, cpoSubCa: true },
        },
        db,
        request.log,
      );
      await publishCaChange(request);
      return statusOf(next);
    },
  );

  app.get(
    '/drivers/:id/pnc-contracts',
    {
      onRequest: [authorize('drivers:read')],
      schema: {
        tags: ['Drivers'],
        summary: 'List the Plug and Charge contracts of a driver',
        operationId: 'listDriverPncContracts',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        response: { 200: itemResponse(z.array(contractItem)) },
      },
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      return contractService.listDriverContracts(id);
    },
  );

  app.post(
    '/drivers/:id/pnc-contracts',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Create a Plug and Charge contract for a driver',
        description:
          'Creates an eMAID token for the driver, bound to the PCID of the vehicle. The local contract CA issues the contract certificate when that vehicle requests it (Get15118EVCertificate).',
        operationId: 'createDriverPncContract',
        security: [{ bearerAuth: [] }],
        params: zodSchema(driverParams),
        body: zodSchema(createContractBody),
        response: {
          201: itemResponse(contractItem),
          400: errorWith('Invalid PCID', [ERROR_CODES.VALIDATION_ERROR]),
          404: errorWith('Driver not found', [ERROR_CODES.DRIVER_NOT_FOUND]),
          409: errorWith(
            'Inactive driver, or the local contract CA or eMAID prefix not configured',
            [
              ERROR_CODES.DRIVER_INACTIVE,
              ERROR_CODES.LOCAL_CA_NOT_CONFIGURED,
              ERROR_CODES.EMAID_PREFIX_NOT_CONFIGURED,
            ],
          ),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof driverParams>;
      const { pcid } = request.body as z.infer<typeof createContractBody>;
      const contract = await contractService.createContract(
        id,
        pcid,
        tokenActorOf(getAuditActor(request)),
        { actor: getAuditActor(request), logger: request.log },
      );
      await reply.status(201).send(contract);
    },
  );

  app.post(
    '/drivers/:id/pnc-contracts/:contractId/revoke',
    {
      onRequest: [authorize('drivers:write')],
      schema: {
        tags: ['Drivers'],
        summary: 'Revoke a Plug and Charge contract',
        description:
          'Revokes the contract and deactivates its eMAID token. Certificates issued for it are reported revoked. Revocation is final.',
        operationId: 'revokePncContract',
        security: [{ bearerAuth: [] }],
        params: zodSchema(contractParams),
        response: {
          200: itemResponse(contractItem),
          404: errorWith('Contract not found', [ERROR_CODES.PNC_CONTRACT_NOT_FOUND]),
        },
      },
    },
    async (request) => {
      const { id, contractId } = request.params as z.infer<typeof contractParams>;
      return contractService.revokeContract(id, contractId, tokenActorOf(getAuditActor(request)), {
        actor: getAuditActor(request),
        logger: request.log,
      });
    },
  );
}
