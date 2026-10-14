// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { CACHE_INVALIDATE_CHANNEL } from '@evtivity/lib';
import { getPubSub } from '@evtivity/lib/pubsub-instance';
import { clearAutochargeCache } from '@evtivity/database';

/** The `cache_invalidate` message kind that clears the Autocharge readers in every OCPP process. */
export const AUTOCHARGE_INVALIDATION_KIND = 'autocharge';

interface WarnLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * After the `autocharge.enabled` setting or a site's override changed: this
 * process reads the new value at once, and every OCPP process clears its
 * cache, so switching Autocharge off applies to the next start. Fail-open:
 * the OCPP caches expire within 60 s anyway.
 */
export async function invalidateAutochargeCaches(log: WarnLogger): Promise<void> {
  clearAutochargeCache();
  try {
    await getPubSub().publish(
      CACHE_INVALIDATE_CHANNEL,
      JSON.stringify({ kind: AUTOCHARGE_INVALIDATION_KIND }),
    );
  } catch (err: unknown) {
    log.warn({ err }, 'Failed to publish the Autocharge cache invalidation');
  }
}
