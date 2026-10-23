// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The request fields the log serializer reads (a Fastify request has them). */
export interface LoggableRequest {
  method: string;
  url: string;
  hostname: string;
  ip: string;
  /** Undefined on the raw request pino sees before routing. */
  routeOptions?: { url?: string | undefined } | undefined;
}

// A type alias, not an interface: pino's serializer result needs an index signature.
export type LoggedRequest = {
  method: string;
  url: string;
  route?: string;
  hostname: string;
  remoteAddress: string;
};

/**
 * The request fields of a process log line, for the API and OCPI processes.
 * The query string is dropped whole: tokens, codes, values a partner sends and
 * any secret parameter added later stay out of the process logs and Loki.
 * `route` is the matched route pattern when known.
 */
export function serializeRequestForLog(request: LoggableRequest): LoggedRequest {
  const path = request.url.split('?')[0] ?? request.url;
  const route = (request.routeOptions as { url?: string } | undefined)?.url;
  return {
    method: request.method,
    url: path,
    ...(route != null ? { route } : {}),
    hostname: request.hostname,
    remoteAddress: request.ip,
  };
}
