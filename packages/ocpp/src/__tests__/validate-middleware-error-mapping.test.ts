// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import { OcppError } from '@evtivity/lib';
import type { HandlerContext } from '../server/middleware/pipeline.js';

// Controllable validator state shared with the mocked registries below. Each
// test sets the AJV errors that the request/response validators report so the
// keyword-to-OcppErrorCode mapping can be exercised exhaustively, including the
// branches that real generated schemas never produce (unmapped keyword,
// empty error list).
interface AjvErr {
  keyword?: string;
  instancePath?: string;
  message?: string;
}

const state: {
  requestValid: boolean;
  requestErrors: AjvErr[] | null;
  responseValid: boolean;
  responseErrors: AjvErr[] | null;
} = {
  requestValid: true,
  requestErrors: [],
  responseValid: true,
  responseErrors: [],
};

function buildRegistry() {
  const validateRequest = ((_: unknown) => state.requestValid) as ((d: unknown) => boolean) & {
    errors?: AjvErr[] | null;
  };
  Object.defineProperty(validateRequest, 'errors', {
    get: () => state.requestErrors,
  });
  const validateResponse = ((_: unknown) => state.responseValid) as ((d: unknown) => boolean) & {
    errors?: AjvErr[] | null;
  };
  Object.defineProperty(validateResponse, 'errors', {
    get: () => state.responseErrors,
  });
  return { ActionRegistry: { FakeAction: { validateRequest, validateResponse } } };
}

vi.mock('../generated/v2_1/registry.js', () => buildRegistry());
vi.mock('../generated/v1_6/registry.js', () => buildRegistry());

const { validateMiddleware } = await import('../server/middleware/validate.js');

const logger = pino({ level: 'silent' });

function makeCtx(protocolVersion = 'ocpp2.1'): HandlerContext {
  return {
    stationId: 'CS-001',
    stationDbId: null,
    session: {
      stationId: 'CS-001',
      stationDbId: null,
      ocppProtocol: protocolVersion,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      authenticated: true,
      pendingMessages: new Map(),
      bootStatus: null,
      readyAnnounced: false,
    },
    protocolVersion,
    messageId: 'msg-1',
    action: 'FakeAction',
    payload: {},
    logger,
    eventBus: { publish: vi.fn(), subscribe: vi.fn() },
    correlator: {} as HandlerContext['correlator'],
    dispatcher: {} as HandlerContext['dispatcher'],
  };
}

describe('validateMiddleware AJV-keyword to OcppErrorCode mapping', () => {
  beforeEach(() => {
    state.requestValid = true;
    state.requestErrors = [];
    state.responseValid = true;
    state.responseErrors = [];
  });

  const occurrenceKeywords = ['required', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
  for (const keyword of occurrenceKeywords) {
    it(`maps ${keyword} to OccurrenceConstraintViolation`, async () => {
      state.requestValid = false;
      state.requestErrors = [{ keyword }];
      const ctx = makeCtx();
      const next = vi.fn();
      try {
        await validateMiddleware(ctx, next);
        throw new Error('expected throw');
      } catch (err) {
        expect((err as OcppError).errorCode).toBe('OccurrenceConstraintViolation');
      }
      expect(next).not.toHaveBeenCalled();
    });
  }

  it('maps type to TypeConstraintViolation', async () => {
    state.requestValid = false;
    state.requestErrors = [{ keyword: 'type' }];
    const ctx = makeCtx();
    await expect(validateMiddleware(ctx, vi.fn())).rejects.toMatchObject({
      errorCode: 'TypeConstraintViolation',
    });
  });

  const propertyKeywords = [
    'enum',
    'pattern',
    'format',
    'maxLength',
    'minLength',
    'maximum',
    'minimum',
    'exclusiveMaximum',
    'exclusiveMinimum',
    'multipleOf',
    'additionalProperties',
    'const',
  ];
  for (const keyword of propertyKeywords) {
    it(`maps ${keyword} to PropertyConstraintViolation`, async () => {
      state.requestValid = false;
      state.requestErrors = [{ keyword }];
      const ctx = makeCtx();
      await expect(validateMiddleware(ctx, vi.fn())).rejects.toMatchObject({
        errorCode: 'PropertyConstraintViolation',
      });
    });
  }

  it('maps an unmapped keyword to FormatViolation (default branch)', async () => {
    state.requestValid = false;
    state.requestErrors = [{ keyword: 'oneOf' }];
    const ctx = makeCtx();
    await expect(validateMiddleware(ctx, vi.fn())).rejects.toMatchObject({
      errorCode: 'FormatViolation',
    });
  });

  it('maps an empty error list to FormatViolation (no first error)', async () => {
    state.requestValid = false;
    state.requestErrors = [];
    const ctx = makeCtx();
    await expect(validateMiddleware(ctx, vi.fn())).rejects.toMatchObject({
      errorCode: 'FormatViolation',
    });
  });

  it('treats null errors as an empty list and still throws FormatViolation', async () => {
    state.requestValid = false;
    state.requestErrors = null;
    const ctx = makeCtx();
    const err = await validateMiddleware(ctx, vi.fn()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OcppError);
    expect((err as OcppError).errorCode).toBe('FormatViolation');
    expect((err as OcppError).errorDetails).toMatchObject({ errors: [] });
  });

  it('selects the ocpp1.6 registry for ocpp1.6 contexts', async () => {
    state.requestValid = false;
    state.requestErrors = [{ keyword: 'type' }];
    const ctx = makeCtx('ocpp1.6');
    await expect(validateMiddleware(ctx, vi.fn())).rejects.toMatchObject({
      errorCode: 'TypeConstraintViolation',
    });
  });

  it('uses an empty error list when response validation fails with null errors', async () => {
    state.responseValid = false;
    state.responseErrors = null;
    const ctx = makeCtx();
    const next = vi.fn().mockImplementation(() => {
      ctx.response = { foo: 'bar' };
      return Promise.resolve();
    });
    const err = await validateMiddleware(ctx, next).catch((e: unknown) => e);
    expect((err as OcppError).errorCode).toBe('InternalError');
    expect((err as OcppError).errorDetails).toMatchObject({ errors: [] });
    expect(next).toHaveBeenCalled();
  });
});
