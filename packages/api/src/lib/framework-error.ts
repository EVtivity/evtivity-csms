// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The code of a framework-level 4xx (Fastify, its plugins and schema
 * validation, never an AppError) by status. Anything not listed is a request
 * the API could not accept as sent: `VALIDATION_ERROR`.
 */
const FRAMEWORK_CODES: Readonly<Record<number, string>> = {
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

function frameworkErrorCode(status: number): string {
  return FRAMEWORK_CODES[status] ?? 'VALIDATION_ERROR';
}

interface FrameworkError {
  statusCode?: number;
  message?: string;
  validation?: Array<{ instancePath?: string; message?: string }>;
}

/**
 * The reply of a framework 4xx error, or null for anything else (5xx and
 * errors without a status, which the caller answers with a generic 500).
 */
export function frameworkClientError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | null {
  const fastifyError = error as FrameworkError;
  const status = fastifyError.statusCode;
  if (status == null || status >= 500) return null;
  // Fastify's AJV validator hangs the failed field list on .validation.
  // Surface it as `details: { fieldName: message }` so frontend forms can
  // show server-side errors next to the offending input instead of a
  // generic banner.
  const details: Record<string, string> = {};
  for (const entry of fastifyError.validation ?? []) {
    const field = entry.instancePath?.replace(/^\//, '') ?? '';
    if (field && entry.message != null && !(field in details)) {
      details[field] = entry.message;
    }
  }
  const body: Record<string, unknown> = {
    error: fastifyError.message,
    code: frameworkErrorCode(status),
  };
  if (Object.keys(details).length > 0) {
    body['details'] = details;
  }
  return { status, body };
}

/** The reply for a request that matches no route. */
export function sendRouteNotFound(_request: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send({ error: 'Not found', code: 'NOT_FOUND' });
}
