// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import { db, ocpiPartners } from '@evtivity/database';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../lib/ocpi-response.js';
import { ocpiAuthenticate } from '../middleware/ocpi-auth.js';
import type { OcpiVersion } from '../types/ocpi.js';

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

  // GET /ocpi/{version}/hubclientinfo - list connected partners
  app.get(prefix, { onRequest: [ocpiAuthenticate] }, async () => {
    const partners = await db
      .select({
        countryCode: ocpiPartners.countryCode,
        partyId: ocpiPartners.partyId,
        roles: ocpiPartners.roles,
        status: ocpiPartners.status,
        updatedAt: ocpiPartners.updatedAt,
      })
      .from(ocpiPartners);

    const data: HubClientInfo[] = partners.map((p) => ({
      party_id: p.partyId,
      country_code: p.countryCode,
      role: Array.isArray(p.roles) ? (p.roles as string[]) : ['CPO'],
      status: mapPartnerStatus(p.status),
      last_updated: p.updatedAt.toISOString(),
    }));

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

      const body = request.body as HubClientInfo | null;
      if (body == null || typeof body.status !== 'string') {
        await reply
          .status(400)
          .send(ocpiError(OcpiStatusCode.CLIENT_INVALID_PARAMS, 'Invalid HubClientInfo object'));
        return;
      }

      // Update partner status if we know them
      const [partner] = await db
        .select({ id: ocpiPartners.id })
        .from(ocpiPartners)
        .where(and(eq(ocpiPartners.countryCode, country_code), eq(ocpiPartners.partyId, party_id)))
        .limit(1);

      if (partner != null) {
        type PartnerStatus = InferInsertModel<typeof ocpiPartners>['status'];
        const statusMap: Record<string, PartnerStatus> = {
          CONNECTED: 'connected',
          OFFLINE: 'disconnected',
          PLANNED: 'pending',
          SUSPENDED: 'suspended',
        };
        const newStatus: PartnerStatus = statusMap[body.status] ?? 'disconnected';
        await db
          .update(ocpiPartners)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(eq(ocpiPartners.id, partner.id));
      }

      return ocpiSuccess(null);
    },
  );
}

export function hubClientInfoRoutes(app: FastifyInstance): void {
  registerHubClientInfoRoutes(app, '2.2.1');
  registerHubClientInfoRoutes(app, '2.3.0');
}
