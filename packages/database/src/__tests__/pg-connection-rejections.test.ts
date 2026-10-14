// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { guardPgConnectionRejections } from '../lib/pg-connection-rejections.js';

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code });
}

describe('guardPgConnectionRejections', () => {
  it('logs a lost-connection rejection at warn and does not throw', () => {
    const target = new EventEmitter();
    const warn = vi.fn();
    guardPgConnectionRejections({ warn }, target);
    expect(() => target.emit('unhandledRejection', pgError('57P01'))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: '57P01' }),
      expect.any(String),
    );
  });

  it('classifies a drizzle-wrapped connection error too', () => {
    const target = new EventEmitter();
    const warn = vi.fn();
    guardPgConnectionRejections({ warn }, target);
    const wrapped = Object.assign(new Error('Failed query'), { cause: pgError('CONNECT_TIMEOUT') });
    expect(() => target.emit('unhandledRejection', wrapped)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('throws any other rejection again, as Node does without a listener', () => {
    const target = new EventEmitter();
    const warn = vi.fn();
    guardPgConnectionRejections({ warn }, target);
    const other = pgError('23505');
    expect(() => target.emit('unhandledRejection', other)).toThrow(other);
    expect(() => target.emit('unhandledRejection', 'plain')).toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves other rejections to another listener when one exists', () => {
    const target = new EventEmitter();
    const other = vi.fn();
    target.on('unhandledRejection', other);
    guardPgConnectionRejections({ warn: vi.fn() }, target);
    expect(() => target.emit('unhandledRejection', new Error('boom'))).not.toThrow();
    expect(other).toHaveBeenCalledOnce();
  });

  it('removes its listener', () => {
    const target = new EventEmitter();
    const remove = guardPgConnectionRejections({ warn: vi.fn() }, target);
    expect(target.listenerCount('unhandledRejection')).toBe(1);
    remove();
    expect(target.listenerCount('unhandledRejection')).toBe(0);
  });
});
