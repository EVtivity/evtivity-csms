// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  AuthError,
  ForbiddenError,
  OcppError,
} from '../errors.js';

describe('AppError', () => {
  it('sets message, statusCode, and code', () => {
    const err = new AppError('test', 500, 'TEST');
    expect(err.message).toBe('test');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('TEST');
    expect(err).toBeInstanceOf(Error);
  });

  it('sets name to AppError', () => {
    const err = new AppError('msg', 400, 'CODE');
    expect(err.name).toBe('AppError');
  });
});

describe('ValidationError', () => {
  it('defaults to 400 status', () => {
    const err = new ValidationError('bad input', { field: 'email' });
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toEqual({ field: 'email' });
  });

  it('sets name to ValidationError', () => {
    const err = new ValidationError('bad');
    expect(err.name).toBe('ValidationError');
  });

  it('defaults details to undefined when not provided', () => {
    const err = new ValidationError('bad input');
    expect(err.details).toBeUndefined();
  });

  it('is an instance of AppError and Error', () => {
    const err = new ValidationError('bad');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('NotFoundError', () => {
  it('includes resource and id in message', () => {
    const err = new NotFoundError('Station', 'abc-123');
    expect(err.message).toBe('Station not found: abc-123');
    expect(err.statusCode).toBe(404);
  });

  it('sets name to NotFoundError and code to NOT_FOUND', () => {
    const err = new NotFoundError('User', '1');
    expect(err.name).toBe('NotFoundError');
    expect(err.code).toBe('NOT_FOUND');
  });

  it('is an instance of AppError', () => {
    const err = new NotFoundError('Site', 'xyz');
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('AuthError', () => {
  it('defaults to 401', () => {
    const err = new AuthError();
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('Unauthorized');
  });

  it('accepts a custom message', () => {
    const err = new AuthError('Token expired');
    expect(err.message).toBe('Token expired');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('sets name to AuthError', () => {
    const err = new AuthError();
    expect(err.name).toBe('AuthError');
  });

  it('is an instance of AppError', () => {
    const err = new AuthError();
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('ForbiddenError', () => {
  it('defaults to 403', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Forbidden');
  });

  it('accepts a custom message', () => {
    const err = new ForbiddenError('Insufficient permissions');
    expect(err.message).toBe('Insufficient permissions');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('sets name to ForbiddenError', () => {
    const err = new ForbiddenError();
    expect(err.name).toBe('ForbiddenError');
  });

  it('is an instance of AppError', () => {
    const err = new ForbiddenError();
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('OcppError', () => {
  it('formats error code and description', () => {
    const err = new OcppError('FormatViolation', 'Invalid payload', { field: 'reason' });
    expect(err.errorCode).toBe('FormatViolation');
    expect(err.errorDescription).toBe('Invalid payload');
    expect(err.errorDetails).toEqual({ field: 'reason' });
    expect(err.message).toBe('FormatViolation: Invalid payload');
  });

  it('defaults errorDetails to empty object', () => {
    const err = new OcppError('InternalError', 'Something went wrong');
    expect(err.errorDetails).toEqual({});
  });

  it('sets name to OcppError', () => {
    const err = new OcppError('GenericError', 'desc');
    expect(err.name).toBe('OcppError');
  });

  it('is an instance of Error but not AppError', () => {
    const err = new OcppError('GenericError', 'desc');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });
});
