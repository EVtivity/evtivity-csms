// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import {
  ceilingExtensionDue,
  extendFleetSessionCeiling,
  getFleetCreditReservationCents,
} from '@evtivity/database';
import type { ProjectionDeps } from '../projection-support/context.js';
import type { FleetCreditThrottle } from './state.js';

/** A running account session of a credit-limited fleet, at a meter reading. */
export interface AccountCeilingInput {
  sessionId: string;
  fleetId: string;
  /** The session's cost ceiling as the reading found it. */
  ceilingCents: number;
  /** The cost at this reading before the ceiling caps it (pricedGrossCents, else grossCents). */
  pricedCents: number;
  /** The cost this reading added (priced cost minus the stored running cost); 0 when not known. */
  lastReadingCents: number;
}

/**
 * The bounded reservation of an account session (plan S8): once the headroom
 * under its ceiling falls below the larger of CEILING_EXTEND_HEADROOM_PERCENT
 * of the slice and twice the cost the last reading added
 * (ceilingExtensionDue), the ceiling grows by another slice under the fleet
 * row lock (extendFleetSessionCeiling), capped at the fleet's credit left.
 * Returns the ceiling the cost loop uses for this reading: the grown one, else
 * the one it had. A ceiling that cannot grow (no credit left) is returned
 * unchanged, and the cost loop stops the session at it.
 *
 * P6: below the ceiling, an extension of a fleet that had no credit left
 * waits one throttle interval (the per-fleet `no_credit` mark), so a fleet at
 * its limit does not take the lock on every reading. At the ceiling it never
 * waits: that call decides whether the session stops.
 *
 * P9: below the ceiling a failure is logged at warn and the next reading
 * tries again. At the ceiling it throws: the reading's stop is skipped rather
 * than stopping a session whose ceiling might have grown.
 */
export async function growAccountCeiling(
  deps: Pick<ProjectionDeps, 'sql' | 'logger'>,
  throttle: FleetCreditThrottle,
  input: AccountCeilingInput,
  now: number = Date.now(),
): Promise<number> {
  const { sessionId, fleetId, ceilingCents, pricedCents, lastReadingCents } = input;
  const atCeiling = pricedCents >= ceilingCents;
  try {
    const sliceCents = await getFleetCreditReservationCents();
    const due = (ceiling: number): boolean =>
      ceilingExtensionDue({ pricedCents, ceilingCents: ceiling, sliceCents, lastReadingCents });
    if (!due(ceilingCents)) return ceilingCents;
    if (!atCeiling && !throttle.due('no_credit', fleetId, now)) return ceilingCents;
    const extension = await extendFleetSessionCeiling(deps.sql, fleetId, sessionId, {
      pricedCents,
      sliceCents,
      lastReadingCents,
    });
    if (extension == null) return ceilingCents;
    if (extension.grown) {
      throttle.clear('no_credit', fleetId);
      deps.logger.info(
        {
          sessionId,
          fleetId,
          previousCents: extension.previousCents,
          ceilingCents: extension.ceilingCents,
        },
        'Account session cost ceiling grown',
      );
      return extension.ceilingCents;
    }
    // Still due after the locked read: the fleet has no credit left.
    if (due(extension.ceilingCents)) {
      throttle.mark('no_credit', fleetId, now);
    }
    return extension.ceilingCents;
  } catch (err) {
    if (atCeiling) throw err;
    deps.logger.warn(
      { err, sessionId, fleetId },
      'Account session ceiling extension failed; the next reading tries again',
    );
    return ceilingCents;
  }
}
