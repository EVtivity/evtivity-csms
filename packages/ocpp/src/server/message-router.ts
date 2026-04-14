// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { Logger } from '@evtivity/lib';
import { OcppError } from '@evtivity/lib';
import { OcppErrorCode } from '../protocol/error-codes.js';
import type { HandlerContext, Middleware } from './middleware/pipeline.js';

export type ActionHandlerFn = (ctx: HandlerContext) => Promise<Record<string, unknown>>;

export class MessageRouter {
  private readonly handlers = new Map<string, Map<string, ActionHandlerFn>>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  register(version: string, action: string, handler: ActionHandlerFn): void {
    let versionMap = this.handlers.get(version);
    if (versionMap == null) {
      versionMap = new Map();
      this.handlers.set(version, versionMap);
    }
    if (versionMap.has(action)) {
      this.logger.warn({ version, action }, 'Overwriting existing handler');
    }
    versionMap.set(action, handler);
    this.logger.debug({ version, action }, 'Handler registered');
  }

  get(version: string, action: string): ActionHandlerFn | undefined {
    return this.handlers.get(version)?.get(action);
  }

  has(version: string, action: string): boolean {
    return this.handlers.get(version)?.has(action) ?? false;
  }

  registeredActions(version?: string): string[] {
    if (version != null) {
      const versionMap = this.handlers.get(version);
      return versionMap != null ? [...versionMap.keys()] : [];
    }
    const all = new Set<string>();
    for (const versionMap of this.handlers.values()) {
      for (const action of versionMap.keys()) {
        all.add(action);
      }
    }
    return [...all];
  }

  asMiddleware(): Middleware {
    return async (ctx, next) => {
      const version = ctx.protocolVersion;
      const handler = this.handlers.get(version)?.get(ctx.action);
      if (handler == null) {
        throw new OcppError(
          OcppErrorCode.NotImplemented,
          `No handler registered for action: ${ctx.action} (version: ${version})`,
        );
      }

      ctx.response = await handler(ctx);
      await next();
    };
  }
}
