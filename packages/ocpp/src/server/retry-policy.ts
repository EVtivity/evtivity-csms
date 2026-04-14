// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from '@evtivity/lib';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export class RetryPolicy {
  private readonly options: RetryOptions;
  private readonly logger: Logger;

  constructor(logger: Logger, options?: Partial<RetryOptions>) {
    this.logger = logger;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async execute<T>(
    action: string,
    fn: () => Promise<T>,
    shouldRetry?: (err: Error) => boolean,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt === this.options.maxRetries) {
          break;
        }

        // Check if this error is retryable
        if (shouldRetry != null && !shouldRetry(lastError)) {
          break;
        }

        const delay = Math.min(
          this.options.baseDelayMs * Math.pow(2, attempt),
          this.options.maxDelayMs,
        );

        this.logger.warn(
          { action, attempt: attempt + 1, delay, error: lastError.message },
          'Retrying after failure',
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError as Error;
  }
}
