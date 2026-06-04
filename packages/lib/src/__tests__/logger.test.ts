// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, afterEach } from 'vitest';
import { createLogger } from '../logger.js';

describe('createLogger', () => {
  const originalLevel = process.env['LOG_LEVEL'];

  afterEach(() => {
    if (originalLevel === undefined) {
      delete process.env['LOG_LEVEL'];
    } else {
      process.env['LOG_LEVEL'] = originalLevel;
    }
  });

  it('returns a logger carrying the configured name as a binding', () => {
    const logger = createLogger('payment-service');
    expect(logger.bindings().name).toBe('payment-service');
  });

  it('exposes the standard pino log methods', () => {
    const logger = createLogger('component-a');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('defaults the level to info when LOG_LEVEL is unset', () => {
    delete process.env['LOG_LEVEL'];
    const logger = createLogger('component-b');
    expect(logger.level).toBe('info');
  });

  it('honors the LOG_LEVEL environment variable', () => {
    process.env['LOG_LEVEL'] = 'debug';
    const logger = createLogger('component-c');
    expect(logger.level).toBe('debug');
  });

  it('serializes the level as a string label and includes name + isoTime', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger('component-d');
    // pino's first transport is a Symbol-keyed write stream. Replacing it lets
    // us inspect the serialized record and confirm the level formatter ran.
    const streamSym = Object.getOwnPropertySymbols(logger).find(
      (s) => s.description === 'pino.stream',
    );
    expect(streamSym).toBeDefined();
    (logger as unknown as Record<symbol, unknown>)[streamSym as symbol] = {
      write: (chunk: string) => lines.push(JSON.parse(chunk) as Record<string, unknown>),
    };

    logger.info('hello world');

    expect(lines).toHaveLength(1);
    const record = lines[0]!;
    // Custom formatter: level becomes the symbolic label, not the numeric 30.
    expect(record['level']).toBe('info');
    expect(record['name']).toBe('component-d');
    expect(record['msg']).toBe('hello world');
    // isoTime puts an ISO-8601 string in `time`.
    expect(typeof record['time']).toBe('string');
    expect(record['time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts authorization, cookie, and stripe-signature headers', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger('redact-service');
    const streamSym = Object.getOwnPropertySymbols(logger).find(
      (s) => s.description === 'pino.stream',
    );
    (logger as unknown as Record<symbol, unknown>)[streamSym as symbol] = {
      write: (chunk: string) => lines.push(JSON.parse(chunk) as Record<string, unknown>),
    };

    logger.info({
      req: {
        headers: {
          authorization: 'Bearer secret-token',
          cookie: 'session=abc',
          'stripe-signature': 'whsec_live',
          'content-type': 'application/json',
        },
      },
    });

    const headers = (lines[0]!['req'] as { headers: Record<string, unknown> }).headers;
    expect(headers['authorization']).toBe('[REDACTED]');
    expect(headers['cookie']).toBe('[REDACTED]');
    expect(headers['stripe-signature']).toBe('[REDACTED]');
    expect(headers['content-type']).toBe('application/json');
  });

  it('produces independent loggers per name', () => {
    const a = createLogger('alpha');
    const b = createLogger('beta');
    expect(a.bindings().name).toBe('alpha');
    expect(b.bindings().name).toBe('beta');
  });
});
