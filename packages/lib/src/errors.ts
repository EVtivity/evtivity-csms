// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  public readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class AuthError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class OcppError extends Error {
  public readonly errorCode: string;
  public readonly errorDescription: string;
  public readonly errorDetails: Record<string, unknown>;

  constructor(
    errorCode: string,
    errorDescription: string,
    errorDetails: Record<string, unknown> = {},
  ) {
    super(`${errorCode}: ${errorDescription}`);
    this.name = 'OcppError';
    this.errorCode = errorCode;
    this.errorDescription = errorDescription;
    this.errorDetails = errorDetails;
  }
}
