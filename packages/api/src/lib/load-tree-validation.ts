// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyReply } from 'fastify';
import { LoadTreeValidationError } from '@evtivity/database';

/**
 * Runs a load management tree write and answers a refused one (a link or
 * shape the tree writer refuses) with 400 VALIDATION_ERROR and the `field` to
 * fix. Returns `{ refused: true }` when it answered. Other errors propagate.
 */
export async function withTreeValidation<T>(
  reply: FastifyReply,
  write: () => Promise<T>,
): Promise<{ refused: false; value: T } | { refused: true }> {
  try {
    return { refused: false, value: await write() };
  } catch (err: unknown) {
    if (err instanceof LoadTreeValidationError) {
      await reply
        .status(400)
        .send({ error: err.message, code: 'VALIDATION_ERROR', field: err.field });
      return { refused: true };
    }
    throw err;
  }
}

/** A 400 VALIDATION_ERROR naming the field, for checks the route makes itself. */
export async function sendFieldError(
  reply: FastifyReply,
  field: string,
  error: string,
): Promise<void> {
  await reply.status(400).send({ error, code: 'VALIDATION_ERROR', field });
}
