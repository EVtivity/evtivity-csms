// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import type { EventBus, Logger, PubSubClient } from '@evtivity/lib';
import type { PaymentContext } from '@evtivity/payments';
import type { ProjectionLookups } from './lookups.js';
import type { ProjectionNotifier } from './notify.js';

/** The dependencies registerProjections builds once and hands to extracted handlers. */
export interface ProjectionDeps {
  sql: postgres.Sql;
  eventBus: EventBus;
  pubsub: PubSubClient;
  logger: Logger;
  payments: PaymentContext;
  lookups: ProjectionLookups;
  notify: ProjectionNotifier;
}
