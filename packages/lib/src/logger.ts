// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import pino from 'pino';

export type Logger = pino.Logger;

/**
 * The line shape of every EVtivity log: the level as a label ("warn", not
 * 40) and an ISO time. The Fastify request loggers of the API and OCPI
 * servers use it too, so one query or alert pattern matches every line.
 */
export const logFormatOptions = {
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
} satisfies pino.LoggerOptions;

/**
 * The logging methods shared server code writes to. Pino loggers and Fastify's
 * app and request loggers all fit, so a service can take either.
 */
export interface ServiceLogger {
  debug(obj: unknown, msg?: string, ...args: unknown[]): void;
  info(obj: unknown, msg?: string, ...args: unknown[]): void;
  warn(obj: unknown, msg?: string, ...args: unknown[]): void;
  error(obj: unknown, msg?: string, ...args: unknown[]): void;
}

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env['LOG_LEVEL'] ?? 'info',
    ...logFormatOptions,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["stripe-signature"]'],
      censor: '[REDACTED]',
    },
  });
}
