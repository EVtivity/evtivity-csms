// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type {
  AiProposalDto,
  AiProposalSource,
  AiProposalStatus,
  AiWorkerJob,
} from '@evtivity/lib/ai-proposals';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';

/**
 * The AI Inbox (`routes/ai-proposals.ts`):
 * proposals from
 * background workers and MCP clients. Nothing runs until a person confirms
 * it here, with their own permissions. The SSE event `ai.proposal.updated`
 * refreshes every query under `AI_PROPOSALS_KEY`.
 */

export const AI_PROPOSALS_KEY = ['ai', 'proposals'] as const;

/**
 * A proposal as the API sends it (`apiKeyName` names the key of an MCP
 * proposal). A client name and version may also come as fields; otherwise
 * the client name is in the MCP summary (untrusted, shown as data).
 */
export interface AiProposalView extends AiProposalDto {
  clientName?: string | null;
  clientVersion?: string | null;
  /** OCPP identity of the target station, for display. */
  stationName?: string | null;
  /** Name of the site, for display. */
  siteName?: string | null;
  /** MCP: the user whose key asked for it. */
  requestedByName?: string | null;
  /** The user who confirmed or rejected it. */
  decidedByName?: string | null;
}

export interface ProposalFilter {
  status?: AiProposalStatus | '';
  source?: AiProposalSource | '';
  job?: AiWorkerJob | '';
  siteId?: string;
  stationId?: string;
  sessionId?: string;
  /** Station OCPP identity, site name, operation or proposal ID. */
  search?: string;
}

interface ProposalPage {
  data: AiProposalView[];
  total: number;
}

export const PROPOSALS_PAGE_SIZE = 20;
const PROPOSAL_STALE_TIME_MS = 15_000;
/** The nav badge also polls, in case the event stream is down. */
const PENDING_COUNT_REFETCH_MS = 60_000;

function listPath(filter: ProposalFilter, page: number, limit: number): string {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  return `/v1/ai/proposals?${params.toString()}`;
}

export function useProposals(
  filter: ProposalFilter,
  page: number,
  options: { limit?: number; enabled?: boolean } = {},
): { proposals: AiProposalView[]; total: number; isLoading: boolean; isError: boolean } {
  const canRead = useHasPermission('aiProposals:read');
  const limit = options.limit ?? PROPOSALS_PAGE_SIZE;
  const enabled = canRead && options.enabled !== false;
  const { data, isLoading, isError } = useQuery({
    queryKey: [...AI_PROPOSALS_KEY, 'list', filter, page, limit],
    queryFn: () => api.get<ProposalPage>(listPath(filter, page, limit)),
    enabled,
    staleTime: PROPOSAL_STALE_TIME_MS,
  });
  return {
    proposals: data?.data ?? [],
    total: data?.total ?? 0,
    isLoading: enabled && isLoading,
    isError,
  };
}

export function useProposal(id: string | undefined): {
  proposal: AiProposalView | undefined;
  isLoading: boolean;
  error: unknown;
} {
  const canRead = useHasPermission('aiProposals:read');
  const { data, isLoading, error } = useQuery({
    queryKey: [...AI_PROPOSALS_KEY, 'detail', id],
    queryFn: () => api.get<AiProposalView>(`/v1/ai/proposals/${encodeURIComponent(id ?? '')}`),
    enabled: canRead && id != null && id !== '',
    staleTime: PROPOSAL_STALE_TIME_MS,
    retry: false,
  });
  return { proposal: data, isLoading: canRead && id != null && isLoading, error };
}

/** Pending proposals the user can see, for the nav badge. */
export function usePendingProposalCount(enabled: boolean): number {
  const canRead = useHasPermission('aiProposals:read');
  const { data } = useQuery({
    queryKey: [...AI_PROPOSALS_KEY, 'pending-count'],
    queryFn: () => api.get<ProposalPage>(listPath({ status: 'pending' }, 1, 1)),
    enabled: canRead && enabled,
    staleTime: PROPOSAL_STALE_TIME_MS,
    refetchInterval: PENDING_COUNT_REFETCH_MS,
  });
  return data?.total ?? 0;
}

export type ProposalDecision =
  | { verb: 'confirm'; id: string; argsHash: string }
  | { verb: 'reject'; id: string };

export function useDecideProposal(): UseMutationResult<AiProposalView, unknown, ProposalDecision> {
  const queryClient = useQueryClient();
  return useMutation<AiProposalView, unknown, ProposalDecision>({
    mutationFn: (d) =>
      api.post<AiProposalView>(
        `/v1/ai/proposals/${encodeURIComponent(d.id)}/${d.verb}`,
        d.verb === 'confirm' ? { argsHash: d.argsHash } : {},
      ),
    onSettled: () => {
      // The proposal changed either way (decided, stale, expired): refresh every view.
      void queryClient.invalidateQueries({ queryKey: AI_PROPOSALS_KEY });
    },
  });
}

/** The tool name of an operation, as the assistant's catalog names it (`ocppv21_reset`). */
export function proposalToolName(operationId: string): string {
  return operationId.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}
