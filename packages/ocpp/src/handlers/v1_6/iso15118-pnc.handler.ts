// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ISO 15118 Plug and Charge on OCPP 1.6 stations, per the Open Charge Alliance
// application note "Using ISO 15118 Plug & Charge with OCPP 1.6" (v1.0,
// 2020-09-16): the station sends the OCPP 2.0.1 messages SignCertificate,
// Get15118EVCertificate, GetCertificateStatus and Authorize in a DataTransfer
// (vendorId org.openchargealliance.iso15118pnc, the message as JSON in data),
// and the answer goes back in the DataTransfer.conf data. Each message runs
// through the OCPP 2.1 handler, so the logic has one code path; this adapter
// only maps the note's simplified message shapes.

import { isPncEnabled } from '@evtivity/database';
import { isPnc16MessageId, unwrapPnc16Data } from '@evtivity/lib';
import type { HandlerContext } from '../../server/middleware/pipeline.js';
import { validateSignCertificateRequest } from '../../generated/v2_1/validators/SignCertificateRequest.validator.js';
import { validateGet15118EVCertificateRequest } from '../../generated/v2_1/validators/Get15118EVCertificateRequest.validator.js';
import { validateGetCertificateStatusRequest } from '../../generated/v2_1/validators/GetCertificateStatusRequest.validator.js';
import { validateAuthorizeRequest } from '../../generated/v2_1/validators/AuthorizeRequest.validator.js';
import { handleSignCertificate } from '../v2_1/sign-certificate.handler.js';
import { handleGet15118EVCertificate } from '../v2_1/get-15118-ev-certificate.handler.js';
import { handleGetCertificateStatus } from '../v2_1/get-certificate-status.handler.js';
import { handleAuthorize } from '../v2_1/authorize.handler.js';

type Validator = (data: unknown) => boolean;

/** AuthorizationStatusEnumType of the note (8.1); other 2.1 statuses answer Invalid. */
const NOTE_AUTHORIZATION_STATUSES = new Set([
  'Accepted',
  'Blocked',
  'ConcurrentTx',
  'Expired',
  'Invalid',
]);

interface Route {
  /** The 2.1 request for the note's message; null when the message cannot be one. */
  toRequest: (message: Record<string, unknown>) => Record<string, unknown> | null;
  validate: Validator;
  handle: (ctx: HandlerContext) => Promise<Record<string, unknown>>;
  /** The note's answer from the 2.1 answer. */
  toAnswer: (answer: Record<string, unknown>) => Record<string, unknown>;
}

const ROUTES: Partial<Record<string, Route>> = {
  // 6.8: only the csr. The note covers the ISO 15118 V2G certificate; the
  // station certificate uses the Security Whitepaper message (2.3).
  SignCertificate: {
    toRequest: (m) =>
      m['certificateType'] === undefined || m['certificateType'] === 'V2GCertificate'
        ? { csr: m['csr'], certificateType: 'V2GCertificate' }
        : null,
    validate: validateSignCertificateRequest,
    handle: handleSignCertificate,
    toAnswer: (a) => ({ status: a['status'] }),
  },
  // 6.4: iso15118SchemaVersion, action, exiRequest; no remainingContracts.
  Get15118EVCertificate: {
    toRequest: (m) => ({
      iso15118SchemaVersion: m['iso15118SchemaVersion'],
      action: m['action'],
      exiRequest: m['exiRequest'],
    }),
    validate: validateGet15118EVCertificateRequest,
    handle: handleGet15118EVCertificate,
    toAnswer: (a) => ({ status: a['status'], exiResponse: a['exiResponse'] ?? '' }),
  },
  // 6.5: ocspResult may only be omitted when status is not Accepted.
  GetCertificateStatus: {
    toRequest: (m) => ({ ocspRequestData: m['ocspRequestData'] }),
    validate: validateGetCertificateStatusRequest,
    handle: handleGetCertificateStatus,
    toAnswer: (a) => ({
      status: a['status'],
      ...(a['status'] === 'Accepted' ? { ocspResult: a['ocspResult'] } : {}),
    }),
  },
  // 6.1 / 5: the IdTokenType has no type; Plug and Charge identifies with the
  // eMAID. The answer carries the note's idTokenInfo and certificateStatus.
  Authorize: {
    toRequest: (m) => {
      const idToken = m['idToken'] as Record<string, unknown> | undefined;
      return {
        idToken: { idToken: idToken?.['idToken'], type: 'eMAID' },
        ...(m['certificate'] !== undefined ? { certificate: m['certificate'] } : {}),
        ...(m['iso15118CertificateHashData'] !== undefined
          ? { iso15118CertificateHashData: m['iso15118CertificateHashData'] }
          : {}),
      };
    },
    validate: validateAuthorizeRequest,
    handle: handleAuthorize,
    toAnswer: (a) => {
      const info = (a['idTokenInfo'] ?? {}) as Record<string, unknown>;
      const status = typeof info['status'] === 'string' ? info['status'] : 'Invalid';
      return {
        idTokenInfo: {
          status: NOTE_AUTHORIZATION_STATUSES.has(status) ? status : 'Invalid',
          ...(typeof info['cacheExpiryDateTime'] === 'string'
            ? { cacheExpiryDateTime: info['cacheExpiryDateTime'] }
            : {}),
        },
        ...(typeof a['certificateStatus'] === 'string'
          ? { certificateStatus: a['certificateStatus'] }
          : {}),
      };
    },
  },
};

/**
 * DataTransfer with the application note's vendorId. Answers UnknownMessageId
 * for a messageId outside the note, Rejected while Plug and Charge is off (the
 * "does not support" answer of 2.1), for a message the station does not send
 * (the CSMS-initiated ones) or a message that is not valid, else Accepted with
 * the answer as JSON in data.
 */
export async function handlePnc16DataTransfer(
  ctx: HandlerContext,
  request: { messageId?: string; data?: string },
): Promise<Record<string, unknown>> {
  if (!isPnc16MessageId(request.messageId)) return { status: 'UnknownMessageId' };
  const route = ROUTES[request.messageId];
  if (route == null) return { status: 'Rejected' };
  if (!(await isPncEnabled())) {
    ctx.logger.warn(
      { stationId: ctx.stationId, messageId: request.messageId },
      'ISO 15118 DataTransfer rejected: PnC disabled',
    );
    return { status: 'Rejected' };
  }
  const message = unwrapPnc16Data(request.data);
  const inner = message == null ? null : route.toRequest(message);
  if (inner == null || !route.validate(inner)) {
    ctx.logger.warn(
      { stationId: ctx.stationId, messageId: request.messageId },
      'ISO 15118 DataTransfer rejected: the wrapped message is not valid',
    );
    return { status: 'Rejected' };
  }
  const answer = await route.handle({ ...ctx, payload: inner });
  return { status: 'Accepted', data: JSON.stringify(route.toAnswer(answer)) };
}
