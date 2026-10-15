// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ocpiSuccess, ocpiError, OcpiStatusCode } from '../lib/ocpi-response.js';
import { ocpiAuthenticateRegistration } from '../middleware/ocpi-auth.js';
import {
  buildOurCredentials,
  CredentialsError,
  handleRegistration,
  handleCredentialUpdate,
  handleUnregister,
} from '../services/credentials.service.js';
import type { OcpiCredentials } from '../types/ocpi.js';

const PRINTABLE_NO_SPACE = /^[\x21-\x7e]+$/;

function isValidRole(role: unknown): boolean {
  if (role == null || typeof role !== 'object') return false;
  const r = role as Record<string, unknown>;
  const details = r['business_details'] as Record<string, unknown> | null | undefined;
  return (
    typeof r['role'] === 'string' &&
    typeof r['country_code'] === 'string' &&
    r['country_code'].length === 2 &&
    typeof r['party_id'] === 'string' &&
    r['party_id'].length === 3 &&
    details != null &&
    typeof details === 'object' &&
    typeof details['name'] === 'string' &&
    details['name'] !== '' &&
    details['name'].length <= 100
  );
}

/** Credentials object, OCPI 2.3.0 7.3.1: token string(64), url, roles. */
function isValidCredentials(body: unknown): body is OcpiCredentials {
  if (body == null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  const token = obj['token'];
  const url = obj['url'];
  const roles = obj['roles'];
  return (
    typeof token === 'string' &&
    token.length <= 64 &&
    PRINTABLE_NO_SPACE.test(token) &&
    typeof url === 'string' &&
    url !== '' &&
    url.length <= 255 &&
    Array.isArray(roles) &&
    roles.length > 0 &&
    roles.every(isValidRole)
  );
}

async function sendInvalidBody(reply: FastifyReply): Promise<void> {
  await reply
    .status(400)
    .send(
      ocpiError(
        OcpiStatusCode.CLIENT_INVALID_PARAMS,
        'Invalid credentials object. Required: token, url, roles[]',
      ),
    );
}

/** A refused handshake answers its own status; anything else a fixed message. */
async function sendHandshakeError(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
  fallback: string,
): Promise<void> {
  if (err instanceof CredentialsError) {
    await reply.status(err.httpStatus).send(ocpiError(err.ocpiStatus, err.message));
    return;
  }
  app.log.error({ err, partnerId: request.ocpiPartner?.partnerId }, fallback);
  await reply.status(500).send(ocpiError(OcpiStatusCode.SERVER_ERROR, fallback));
}

function registerCredentialRoutes(app: FastifyInstance, version: '2.2.1' | '2.3.0'): void {
  // GET /ocpi/{version}/credentials - our credentials (any token we issued).
  app.get(`/ocpi/${version}/credentials`, { onRequest: [ocpiAuthenticateRegistration] }, () => {
    const credentials = buildOurCredentials('');
    return ocpiSuccess(credentials);
  });

  // POST /ocpi/{version}/credentials - registration with a registration token.
  app.post(
    `/ocpi/${version}/credentials`,
    { onRequest: [ocpiAuthenticateRegistration] },
    async (request, reply) => {
      const partner = request.ocpiPartner;
      const token = request.ocpiToken;
      if (partner?.partnerId == null || token == null) {
        await reply
          .status(401)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Authentication failed'));
        return;
      }

      // 7.2.2: 405 when the client has already been registered.
      if (token.kind !== 'registration' || token.partnerStatus === 'connected') {
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

      const body = request.body;
      if (!isValidCredentials(body)) {
        await sendInvalidBody(reply);
        return;
      }

      try {
        // Prefer the OCPI version the partner POSTed to: the version they
        // explicitly accepted.
        const result = await handleRegistration(
          body,
          { tokenId: partner.tokenId, partnerId: partner.partnerId },
          version,
        );
        await reply.status(201).send(ocpiSuccess(result));
      } catch (err) {
        await sendHandshakeError(app, request, reply, err, 'Registration failed');
      }
    },
  );

  // PUT /ocpi/{version}/credentials - update the credentials of a registered partner.
  app.put(
    `/ocpi/${version}/credentials`,
    { onRequest: [ocpiAuthenticateRegistration] },
    async (request, reply) => {
      const partner = request.ocpiPartner;
      // 7.2.3: 405 when the client has not been registered yet (it holds a
      // registration token only).
      if (partner?.partnerId == null || request.ocpiToken?.kind !== 'credentials') {
        await reply
          .status(405)
          .send(ocpiError(OcpiStatusCode.CLIENT_ERROR, 'Not registered. Use POST to register.'));
        return;
      }

      const body = request.body;
      if (!isValidCredentials(body)) {
        await sendInvalidBody(reply);
        return;
      }

      try {
        const result = await handleCredentialUpdate(body, partner.partnerId, version);
        return ocpiSuccess(result);
      } catch (err) {
        await sendHandshakeError(app, request, reply, err, 'Credential update failed');
        return;
      }
    },
  );

  // DELETE /ocpi/{version}/credentials - unregister
  app.delete(
    `/ocpi/${version}/credentials`,
    { onRequest: [ocpiAuthenticateRegistration] },
    async (request, reply) => {
      const partner = request.ocpiPartner;
      if (partner?.partnerId == null || request.ocpiToken?.kind !== 'credentials') {
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
