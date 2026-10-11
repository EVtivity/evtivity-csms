// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ProposalCard } from './ProposalCard';
import { useProposals } from './proposal-api';

const SHOWN = 3;

/**
 * Pending AI proposals of a station or session, shown inline on its page.
 * Renders nothing without `aiProposals:read` or when none is pending.
 */
export function RecordProposals({
  stationId,
  sessionId,
}: {
  stationId?: string;
  sessionId?: string;
}): React.JSX.Element | null {
  const { proposals } = useProposals(
    {
      status: 'pending',
      ...(stationId != null ? { stationId } : {}),
      ...(sessionId != null ? { sessionId } : {}),
    },
    1,
    { limit: SHOWN, enabled: stationId != null || sessionId != null },
  );
  if (proposals.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="ai-record-proposals">
      {proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
    </div>
  );
}
