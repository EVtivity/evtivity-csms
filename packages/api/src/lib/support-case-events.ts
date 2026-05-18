// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { getPubSub } from './pubsub.js';

// Real-time fan-out for support-case state changes. Operators receive every
// event on csms_events; the owning driver also receives it on portal_events
// so the driver portal can refetch its case detail without polling.
//
// The portal SSE endpoint filters by driverId before broadcasting, so
// drivers only see events for cases they own. Pass driverId = null when the
// event should not reach the portal (e.g. internal operator notes, cases
// not linked to a driver).
export async function notifySupportCaseEvent(
  eventType: 'supportCase.created' | 'supportCase.updated' | 'supportCase.newMessage',
  caseId: string,
  driverId: string | null,
): Promise<void> {
  const pubsub = getPubSub();
  await pubsub.publish('csms_events', JSON.stringify({ eventType, caseId }));
  if (driverId != null) {
    await pubsub.publish('portal_events', JSON.stringify({ type: eventType, caseId, driverId }));
  }
}
