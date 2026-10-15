// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import { db, ocpiPartners, ocpiPartnerAuditLog, writeAudit } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../middleware/ocpi-auth.js';
import type { OcpiVersion } from '../types/ocpi.js';

type PartnerStatus = InferInsertModel<typeof ocpiPartners>['status'];

/** OCPI ConnectionStatus (2.3.0 16.4.1) to the partner status. */
const STATUS_MAP: Record<string, PartnerStatus> = {
  CONNECTED: 'connected',
  OFFLINE: 'disconnected',
  PLANNED: 'pending',
  SUSPENDED: 'suspended',
};

/** Hub client info is the hub's to send: only a partner registered with the HUB role. */
function isHub(request: FastifyRequest): boolean {
  return request.ocpiToken?.roleNames.includes('HUB') === true;
}

interface HubClientInfo {
  party_id: string;
  country_code: string;
  role: string[];
  status: 'CONNECTED' | 'OFFLINE' | 'PLANNED' | 'SUSPENDED';
  last_updated: string;
}

function mapPartnerStatus(status: string): 'CONNECTED' | 'OFFLINE' | 'PLANNED' | 'SUSPENDED' {
  switch (status) {
    case 'connected':
      return 'CONNECTED';
    case 'suspended':
      return 'SUSPENDED';
    case 'pending':
      return 'PLANNED';
    case 'disconnected':
      return 'OFFLINE';
    default:
      return 'OFFLINE';
  }
}

function registerHubClientInfoRoutes(app: FastifyInstance, version: OcpiVersion): void {
  const prefix = `/ocpi/${version}/hubclientinfo`;

  // GET /ocpi/{version}/hubclientinfo - list connected partners (hub only)
  app.get(prefix, { onRequest: [ocpiAuthenticate] }, async (request, reply) => {
    if (!isHub(request)) {
      await reply
        .status(403)
        .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Hub client info is available to a hub only'));
      return;
    }
    const partners = await db
      .select({
        countryCode: ocpiPartners.countryCode,
        partyId: ocpiPartners.partyId,
        roles: ocpiPartners.roles,
        status: ocpiPartners.status,
        updatedAt: ocpiPartners.updatedAt,
      })
      .from(ocpiPartners);

    // `ocpi_partners.roles` is a JSONB array of OcpiCredentialRole objects
    // ({ role, party_id, country_code, business_details }). HubClientInfo's
    // `role` field is a list of role-name strings ("CPO" / "EMSP" / ...).
    // The earlier cast `as string[]` left full role objects in the response,
    // which serialize as `[object Object]`-style garbage on the wire.
    const data: HubClientInfo[] = partners.map((p) => {
      const roleArr = Array.isArray(p.roles)
        ? (p.roles as unknown[])
            .map((r) => {
              if (r == null || typeof r !== 'object') return null;
              const role = (r as { role?: unknown }).role;
              return typeof role === 'string' ? role : null;
            })
            .filter((r): r is string => r != null)
        : [];
      return {
        party_id: p.partyId,
        country_code: p.countryCode,
        role: roleArr.length > 0 ? roleArr : ['CPO'],
        status: mapPartnerStatus(p.status),
        last_updated: p.updatedAt.toISOString(),
      };
    });

    return ocpiSuccess(data);
  });

  // PUT /ocpi/{version}/hubclientinfo/:country_code/:party_id - receive partner status from hub
  app.put(
    `${prefix}/:country_code/:party_id`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const { country_code, party_id } = request.params as {
        country_code: string;
        party_id: string;
      };

      // OCPI 2.3.0 16: the hub sends the connection status of the OTHER
      // parties it connects us to. Only a partner registered with the HUB
      // role may send it, and never for its own row (a suspended hub must not
      // lift its own suspension).
      const authenticated = request.ocpiPartner;
      if (
        authenticated == null ||
        !isHub(request) ||
        (authenticated.countryCode === country_code && authenticated.partyId === party_id)
      ) {
        await reply
          .status(403)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Hub client info can only come from a hub'));
        return;
      }

      const body = request.body as HubClientInfo | null;
      const newStatus = typeof body?.status === 'string' ? STATUS_MAP[body.status] : undefined;
      if (body == null || newStatus == null) {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid HubClientInfo object'));
        return;
      }

      // Update partner status if we know them
      const [partner] = await db
        .select({ id: ocpiPartners.id, status: ocpiPartners.status })
        .from(ocpiPartners)
        .where(and(eq(ocpiPartners.countryCode, country_code), eq(ocpiPartners.partyId, party_id)))
        .limit(1);

      // A partner that never completed its own credentials handshake stays
      // pending: CONNECTED from the hub does not register it.
      const skip = partner?.status === 'pending' && newStatus === 'connected';
      if (partner != null && !skip) {
        await db
          .update(ocpiPartners)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(eq(ocpiPartners.id, partner.id));
        // The hub's status report is a system write: audit a change only.
        if (partner.status !== newStatus) {
          await writeAudit(
            { table: ocpiPartnerAuditLog, idColumn: 'ocpi_partner_id' },
            {
              entityId: partner.id,
              entityIdSnapshot: partner.id,
              action: 'updated',
              actor: 'system',
              actorLabel: 'ocpi-hubclientinfo',
              before: { status: partner.status },
              after: { status: newStatus, hubStatus: body.status },
              notes: 'Status reported by the hub (PUT hubclientinfo)',
            },
            db,
            request.log,
          );
        }
      }

      return ocpiSuccess(null);
    },
  );
}

export function hubClientInfoRoutes(app: FastifyInstance): void {
  registerHubClientInfoRoutes(app, '2.2.1');
  registerHubClientInfoRoutes(app, '2.3.0');
}
