// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply, FastifyRequest } from 'fastify';

export interface OcpiPaginationParams {
  offset: number;
  limit: number;
  dateFrom?: Date;
  dateTo?: Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

export function parsePaginationParams(request: FastifyRequest): OcpiPaginationParams {
  const query = request.query as Record<string, string | undefined>;

  const offset = Math.max(0, Number(query['offset'] ?? '0') || 0);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(query['limit'] ?? String(DEFAULT_LIMIT)) || DEFAULT_LIMIT),
  );

  let dateFrom: Date | undefined;
  let dateTo: Date | undefined;

  if (query['date_from'] != null && query['date_from'] !== '') {
    dateFrom = new Date(query['date_from']);
    if (isNaN(dateFrom.getTime())) {
      dateFrom = undefined;
    }
  }

  if (query['date_to'] != null && query['date_to'] !== '') {
    dateTo = new Date(query['date_to']);
    if (isNaN(dateTo.getTime())) {
      dateTo = undefined;
    }
  }

  const result: OcpiPaginationParams = { offset, limit };
  if (dateFrom != null) result.dateFrom = dateFrom;
  if (dateTo != null) result.dateTo = dateTo;
  return result;
}

export function setPaginationHeaders(
  reply: FastifyReply,
  request: FastifyRequest,
  totalCount: number,
  limit: number,
  offset: number,
): void {
  reply.header('X-Total-Count', String(totalCount));
  reply.header('X-Limit', String(limit));

  const nextOffset = offset + limit;
  if (nextOffset < totalCount) {
    const pathPart = request.url.split('?')[0] ?? request.url;
    const baseUrl = `${request.protocol}://${request.hostname}${pathPart}`;
    const query = request.query as Record<string, string | undefined>;
    const params = new URLSearchParams();
    params.set('offset', String(nextOffset));
    params.set('limit', String(limit));
    const dateFrom = query['date_from'];
    const dateTo = query['date_to'];
    if (dateFrom != null) params.set('date_from', dateFrom);
    if (dateTo != null) params.set('date_to', dateTo);
    reply.header('Link', `<${baseUrl}?${params.toString()}>; rel="next"`);
  }
}
