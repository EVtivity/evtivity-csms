// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { useDriverTimezone } from '@/lib/timezone';

interface SupportCase {
  id: string;
  caseNumber: string;
  subject: string;
  status: string;
  updatedAt: string;
}

interface PaginatedResponse {
  data: SupportCase[];
  total: number;
}

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  switch (status) {
    case 'open':
      return 'default';
    case 'in_progress':
    case 'resolved':
      return 'secondary';
    default:
      return 'outline';
  }
}

export function AccountSupportCases(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useDriverTimezone();

  const { data } = useQuery({
    queryKey: ['portal-support-cases'],
    queryFn: () => api.get<PaginatedResponse>('/v1/portal/support-cases?limit=5'),
  });

  const cases = data?.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {data != null ? `${String(data.total)} ${t('account.totalCases')}` : ''}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigate('/support/new');
          }}
        >
          <Plus className="mr-1 h-3 w-3" />
          {t('supportCases.newCase')}
        </Button>
      </div>

      {cases.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('supportCases.noCases')}</p>
      )}

      {cases.map((c) => (
        <button
          key={c.id}
          onClick={() => {
            void navigate(`/support/${c.id}`);
          }}
          className="flex w-full items-center justify-between rounded-md border p-3 text-left transition-colors hover:bg-accent/50"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{c.caseNumber}</span>
              <Badge variant={statusVariant(c.status)}>
                {t(`supportCases.statuses.${c.status}`)}
              </Badge>
            </div>
            <p className="truncate text-sm">{c.subject}</p>
            <p className="text-xs text-muted-foreground">{formatDate(c.updatedAt, timezone)}</p>
          </div>
          <ChevronRight className="ml-2 h-4 w-4 text-muted-foreground" />
        </button>
      ))}

      {(data?.total ?? 0) > 5 && (
        <button
          onClick={() => {
            void navigate('/support');
          }}
          className="flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {t('account.viewAllCases')}
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
