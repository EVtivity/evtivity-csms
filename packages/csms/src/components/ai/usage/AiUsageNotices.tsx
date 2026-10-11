// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import type { AiUsageNotice } from './usage-notices';
import { useAiUsageNotices } from './usage-notices';

/** The text of a threshold notice; a site notice names the site. */
export function useNoticeText(): (notice: AiUsageNotice, siteName: string | null) => string {
  const { t } = useTranslation();
  return (notice, siteName) => {
    if (notice.scope === 'company') {
      return notice.level === 'exceeded'
        ? t('aiUsage.thresholdExceededCompany')
        : t('aiUsage.thresholdWarningCompany', { percent: notice.percent });
    }
    const site = siteName ?? notice.siteId ?? '';
    return notice.level === 'exceeded'
      ? t('aiUsage.thresholdExceededSite', { site })
      : t('aiUsage.thresholdWarningSite', { site, percent: notice.percent });
  };
}

function NoticeAlert({ notice }: { notice: AiUsageNotice }): React.JSX.Element {
  const { t } = useTranslation();
  const dismiss = useAiUsageNotices((s) => s.dismiss);
  const text = useNoticeText();
  const canReadSites = useHasPermission('sites:read');
  const { data: site } = useQuery({
    queryKey: ['sites', notice.siteId],
    queryFn: () => api.get<{ name: string }>(`/v1/sites/${notice.siteId ?? ''}`),
    enabled: notice.siteId != null && canReadSites,
    staleTime: 60_000,
  });
  return (
    <Alert variant={notice.level === 'exceeded' ? 'destructive' : 'warning'} className="pr-10">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription>{text(notice, site?.name ?? null)}</AlertDescription>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-1 top-1"
        aria-label={t('common.dismiss')}
        onClick={() => {
          dismiss(notice);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </Alert>
  );
}

/**
 * Budget threshold banners from the `ai.usage.threshold` SSE event (plan
 * 7.1). Inline and dismissible, never a toast that stays open.
 */
export function AiUsageNotices({ className }: { className?: string }): React.JSX.Element | null {
  const notices = useAiUsageNotices((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className={className} data-testid="ai-usage-notices">
      <div className="space-y-2">
        {notices.map((n) => (
          <NoticeAlert key={`${n.scope}:${n.siteId ?? ''}`} notice={n} />
        ))}
      </div>
    </div>
  );
}
