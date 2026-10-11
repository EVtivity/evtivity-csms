// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { DRIVER_AI_NOTICE_VERSIONS } from '@evtivity/lib/driver-ai';
import type {
  DriverAiCaseDetail,
  DriverAiConsentInput,
  DriverAiState,
} from '@evtivity/lib/driver-ai';
import { UI_LANGUAGES } from '@evtivity/lib/languages';
import { api } from '@/lib/api';

export type PortalCaseAi = DriverAiCaseDetail;

interface DriverAiFeatures {
  driverAiSupport?: boolean;
  driverAiNoticeVersion?: number;
}

/**
 * Whether new cases offer the AI analysis, and the notice version to show.
 * The portal ships the text of each known version (`supportCases.ai.notice.v<n>`);
 * a version it has no text for means the build is older than the server, so
 * the consent step is not offered (the case then goes to the support team).
 */
export function useDriverAiFeature(): {
  available: boolean;
  noticeVersion: number | null;
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () => api.get<DriverAiFeatures>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });
  const version = data?.driverAiNoticeVersion;
  const known = typeof version === 'number' && DRIVER_AI_NOTICE_VERSIONS.includes(version);
  return {
    available: data?.driverAiSupport === true && known,
    noticeVersion: known ? version : null,
    // A failed read is not loading: the form shows without the AI step.
    isLoading,
  };
}

/** The UI language the notice was shown in, as the consent DTO takes it. */
export function consentLanguage(language: string | undefined): DriverAiConsentInput['language'] {
  const match = UI_LANGUAGES.find((l) => l === language);
  return match ?? 'en';
}

const ANALYZING_STATES: readonly DriverAiState[] = ['queued', 'analyzing'];

/** True while the automatic answer is still being prepared. */
export function isAiAnalyzing(ai: PortalCaseAi | null | undefined): boolean {
  return ai?.state != null && ANALYZING_STATES.includes(ai.state);
}
