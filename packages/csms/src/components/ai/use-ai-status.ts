// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';

/** Invalidated when the AI settings or a personal AI configuration change. */
export const AI_STATUS_KEY = ['ai-status'] as const;

interface AiStatusResponse {
  enabled: boolean;
  supportAssistEnabled: boolean;
}

export interface AiStatus {
  /** The chat button and panel may render: enabled, a provider and its key, and `aiAssistant:read`. */
  chatbot: boolean;
  /** Support AI drafts may run for this user. */
  support: boolean;
  isLoading: boolean;
}

/**
 * `GET /v1/assistant/status`. Fails closed: until it answers, on an error,
 * or without `aiAssistant:read`, nothing AI renders.
 */
export function useAiStatus(): AiStatus {
  const canRead = useHasPermission('aiAssistant:read');
  const { data, isLoading } = useQuery({
    queryKey: AI_STATUS_KEY,
    queryFn: () => api.get<AiStatusResponse>('/v1/assistant/status'),
    enabled: canRead,
    staleTime: 60_000,
    retry: false,
  });
  return {
    chatbot: canRead && data?.enabled === true,
    support: canRead && data?.supportAssistEnabled === true,
    isLoading: canRead && isLoading,
  };
}
