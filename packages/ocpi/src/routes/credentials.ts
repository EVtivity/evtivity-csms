// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../lib/ocpi-response.js';
import { ocpiAuthenticate, ocpiAuthenticateRegistration } from '../middleware/ocpi-auth.js';
import {
  buildOurCredentials,
  handleRegistration,
  handleCredentialUpdate,
  handleUnregister,
} from '../services/credentials.service.js';
import type { OcpiCredentials } from '../types/ocpi.js';

function isValidCredentials(body: unknown): body is OcpiCredentials {
  if (body == null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj['token'] === 'string' &&
    typeof obj['url'] === 'string' &&
    Array.isArray(obj['roles']) &&
    (obj['roles'] as unknown[]).length > 0
  );
}

function registerCredentialRoutes(app: FastifyInstance, version: string): void {
  // GET /ocpi/{version}/credentials - return our credentials
  app.get(`/ocpi/${version}/credentials`, { onRequest: [ocpiAuthenticate] }, () => {
    const credentials = buildOurCredentials('');
    return ocpiSuccess(credentials);
  });

  // POST /ocpi/{version}/credentials - partner initiates registration
  app.post(
    `/ocpi/${version}/credentials`,
    { onRequest: [ocpiAuthenticateRegistration] },
    async (request, reply) => {
      const body = request.body;
      if (!isValidCredentials(body)) {
        await reply
          .status(400)
          .send(
            ocpiError(
              OcpiStatusCode.CLIENT_INVALID_PARAMS,
              'Invalid credentials object. Required: token, url, roles[]',
            ),
          );
        return;
      }

      const partner = request.ocpiPartner;
      if (partner == null) {
        await reply
          .status(401)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Authentication failed'));
        return;
      }

      // If partner is already registered, reject POST (use PUT to update)
      if (partner.partnerId != null) {
        await reply
          .status(405)
          .send(
            ocpiError(
              OcpiStatusCode.CLIENT_ERROR,
              'Already registered. Use PUT to update credentials.',
            ),
          );
        return;
      }

      try {
        const result = await handleRegistration(body, partner.tokenId);
        await reply.status(201).send(ocpiSuccess(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Registration failed';
        app.log.error({ err }, 'OCPI registration failed');
        await reply.status(400).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, message));
      }
      return;
    },
  );

  // PUT /ocpi/{version}/credentials - update existing registration
  app.put(
    `/ocpi/${version}/credentials`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const body = request.body;
      if (!isValidCredentials(body)) {
        await reply
          .status(400)
          .send(
            ocpiError(
              OcpiStatusCode.CLIENT_INVALID_PARAMS,
              'Invalid credentials object. Required: token, url, roles[]',
            ),
          );
        return;
      }

      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply
          .status(405)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not registered. Use POST to register.'));
        return;
      }

      try {
        const result = await handleCredentialUpdate(body, partner.partnerId);
        return ocpiSuccess(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Credential update failed';
        app.log.error({ err }, 'OCPI credential update failed');
        await reply.status(400).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, message));
        return;
      }
    },
  );

  // DELETE /ocpi/{version}/credentials - unregister
  app.delete(
    `/ocpi/${version}/credentials`,
    { onRequest: [ocpiAuthenticate] },
    async (request, reply) => {
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null) {
        await reply.status(405).send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not registered'));
        return;
      }

      await handleUnregister(partner.partnerId);
      return ocpiSuccess(null);
    },
  );
}

export function credentialRoutes(app: FastifyInstance): void {
  registerCredentialRoutes(app, '2.2.1');
  registerCredentialRoutes(app, '2.3.0');
}
