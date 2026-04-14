// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger, EventBus } from '@evtivity/lib';
import type { SessionState } from '../session-state.js';
import type { MessageCorrelator } from '../message-correlator.js';
import type { CommandDispatcher } from '../command-dispatcher.js';

export interface HandlerContext {
  stationId: string;
  stationDbId: string | null;
  session: SessionState;
  protocolVersion: string;
  messageId: string;
  action: string;
  payload: Record<string, unknown>;
  response?: Record<string, unknown> | undefined;
  logger: Logger;
  eventBus: EventBus;
  correlator: MessageCorrelator;
  dispatcher: CommandDispatcher;
}

export type NextFunction = () => Promise<void>;
export type Middleware = (ctx: HandlerContext, next: NextFunction) => Promise<void>;

export class MiddlewarePipeline {
  private readonly middlewares: Middleware[] = [];

  use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  async execute(ctx: HandlerContext): Promise<void> {
    let index = 0;

    const next = async (): Promise<void> => {
      const middleware = this.middlewares[index];
      if (middleware != null) {
        index++;
        await middleware(ctx, next);
      }
    };

    await next();
  }
}
